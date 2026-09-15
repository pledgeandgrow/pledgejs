/**
 * SAML 2.0 enterprise SSO.
 *
 * Provides:
 * - Service provider metadata generation
 * - Signed assertions
 * - IdP-initiated and SP-initiated flows
 * - SAML response parsing and validation
 */

import { createHash, createVerify, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';

// ============================================================================
// Minimal XML parser + exclusive canonicalization (C14N) subset.
//
// Real IdPs sign the CANONICALIZED SignedInfo and digest the canonicalized
// assertion with the Signature element removed (enveloped-signature
// transform). Verifying against raw extracted text alone fails against
// every real IdP. This is a compact parser with source-offset tracking so
// each element can be reconstructed as raw bytes, canonicalized, or
// canonicalized with its Signature children stripped.
// ============================================================================

interface XmlAttribute {
  name: string;
  value: string;
}

interface XmlElementNode {
  type: 'element';
  prefix: string | null;
  local: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
  parent: XmlElementNode | null;
  /** Source offset of the opening '<'. */
  start: number;
  /** Source offset just past the closing '>'. */
  end: number;
}

type XmlNode = XmlElementNode | { type: 'text'; text: string };

function isElement(node: XmlNode): node is XmlElementNode {
  return node.type === 'element';
}

function parseXmlDocument(src: string): XmlElementNode | null {
  let i = 0;
  const len = src.length;

  const skipPrologAndMisc = (): void => {
    for (;;) {
      while (i < len && /\s/.test(src[i])) i++;
      if (src.startsWith('<?', i)) {
        const end = src.indexOf('?>', i);
        i = end === -1 ? len : end + 2;
      } else if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        i = end === -1 ? len : end + 3;
      } else if (src.startsWith('<!', i)) {
        // DOCTYPE etc. — skip to matching '>'
        const end = src.indexOf('>', i);
        i = end === -1 ? len : end + 1;
      } else {
        return;
      }
    }
  };

  const parseName = (): string => {
    const start = i;
    while (i < len && /[A-Za-z0-9_.:-]/.test(src[i])) i++;
    return src.slice(start, i);
  };

  const parseElement = (parent: XmlElementNode | null): XmlElementNode | null => {
    // Precondition: src[i] === '<' and next char is a name start.
    const start = i;
    i++; // '<'
    const qualified = parseName();
    if (!qualified) return null;
    const colonIdx = qualified.indexOf(':');
    const prefix = colonIdx === -1 ? null : qualified.slice(0, colonIdx);
    const local = colonIdx === -1 ? qualified : qualified.slice(colonIdx + 1);

    const attributes: XmlAttribute[] = [];
    let selfClosing = false;

    for (;;) {
      while (i < len && /\s/.test(src[i])) i++;
      if (i >= len) return null;
      if (src[i] === '>') {
        i++;
        break;
      }
      if (src[i] === '/') {
        // '/>' — self-closing
        if (src[i + 1] === '>') {
          selfClosing = true;
          i += 2;
          break;
        }
        return null;
      }
      const attrName = parseName();
      if (!attrName) return null;
      while (i < len && /\s/.test(src[i])) i++;
      if (src[i] !== '=') return null;
      i++;
      while (i < len && /\s/.test(src[i])) i++;
      const quote = src[i];
      if (quote !== '"' && quote !== "'") return null;
      i++;
      const valueStart = i;
      while (i < len && src[i] !== quote) i++;
      if (i >= len) return null;
      attributes.push({ name: attrName, value: src.slice(valueStart, i) });
      i++; // closing quote
    }

    const node: XmlElementNode = {
      type: 'element',
      prefix,
      local,
      attributes,
      children: [],
      parent,
      start,
      end: i,
    };

    if (selfClosing) return node;

    // Parse children until the matching close tag.
    for (;;) {
      if (i >= len) return null;
      const lt = src.indexOf('<', i);
      if (lt === -1) return null;
      if (lt > i) node.children.push({ type: 'text', text: src.slice(i, lt) });
      i = lt;
      if (src.startsWith('</', i)) {
        i += 2;
        const closeName = parseName();
        while (i < len && /\s/.test(src[i])) i++;
        if (src[i] !== '>') return null;
        i++;
        if (closeName !== qualified) return null; // mismatched close
        node.end = i;
        return node;
      }
      if (src.startsWith('<!--', i)) {
        const end = src.indexOf('-->', i);
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i);
        const text = src.slice(i + 9, end === -1 ? len : end);
        node.children.push({ type: 'text', text });
        i = end === -1 ? len : end + 3;
        continue;
      }
      const child = parseElement(node);
      if (!child) return null;
      node.children.push(child);
    }
  };

  skipPrologAndMisc();
  if (i >= len || src[i] !== '<') return null;
  return parseElement(null);
}

/** Raw source bytes of an element (exactly as it appeared in the document). */
function rawBytes(el: XmlElementNode, src: string): string {
  return src.slice(el.start, el.end);
}

/** Finds all descendant elements with the given local name. */
function findAllElements(el: XmlElementNode, local: string): XmlElementNode[] {
  const out: XmlElementNode[] = [];
  const walk = (node: XmlElementNode): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      if (child.local === local) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

/** Finds the first descendant element with the given local name. */
function findFirstElement(el: XmlElementNode, local: string): XmlElementNode | null {
  for (const child of el.children) {
    if (isElement(child)) {
      if (child.local === local) return child;
      const found = findFirstElement(child, local);
      if (found) return found;
    }
  }
  return null;
}

function getAttribute(el: XmlElementNode, name: string): string | null {
  const attr = el.attributes.find((a) => a.name === name);
  return attr ? attr.value : null;
}

/**
 * Serializes a subtree using a practical subset of exclusive C14N:
 * - namespace declarations rendered before attributes, both sorted;
 * - empty elements rendered as <tag></tag>;
 * - attribute values escaped, whitespace-normalized;
 * - line endings normalized to \n in text.
 */
function c14n(el: XmlElementNode, excludeSignatureChildren = false): string {
  const parts: string[] = [];
  const render = (node: XmlElementNode): void => {
    const qualified = node.prefix ? `${node.prefix}:${node.local}` : node.local;

    const xmlnsDecls: XmlAttribute[] = [];
    const otherAttrs: XmlAttribute[] = [];
    for (const attr of node.attributes) {
      if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) xmlnsDecls.push(attr);
      else otherAttrs.push(attr);
    }
    xmlnsDecls.sort((a, b) => a.name.localeCompare(b.name));
    otherAttrs.sort((a, b) => a.name.localeCompare(b.name));

    let attrs = '';
    for (const attr of [...xmlnsDecls, ...otherAttrs]) {
      attrs += ` ${attr.name}="${escapeC14nAttr(attr.value)}"`;
    }
    parts.push(`<${qualified}${attrs}>`);

    for (const child of node.children) {
      if (!isElement(child)) {
        parts.push(escapeC14nText(child.text));
        continue;
      }
      if (excludeSignatureChildren && child.local === 'Signature') continue;
      render(child);
    }
    parts.push(`</${qualified}>`);
  };
  render(el);
  return parts.join('');
}

function escapeC14nAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

function escapeC14nText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface SAMLConfig {
  /** Entity ID for the service provider */
  entityId: string;
  /** Assertion Consumer Service URL */
  acsUrl: string;
  /** SP private key (PEM) */
  privateKey: string;
  /** SP certificate (PEM) */
  certificate: string;
  /** IdP entity ID */
  idpEntityId: string;
  /** IdP SSO URL */
  idpSsoUrl: string;
  /** IdP certificate (PEM) for signature verification */
  idpCertificate: string;
  /** Whether to sign requests (default: true) */
  signRequests?: boolean;
  /** Whether to want signed assertions (default: true) */
  wantSignedAssertions?: boolean;
  /** NameID format (default: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress') */
  nameIdFormat?: string;
}

export interface SAMLAuthnRequest {
  id: string;
  samlRequest: string;
  redirectUrl: string;
}

export interface SAMLUserInfo {
  nameId: string;
  attributes: Record<string, string[]>;
  issuer: string;
  sessionIndex?: string;
  notOnOrAfter?: number;
}

const DEFAULT_NAMEID_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';

/**
 * Escape XML metacharacters for safe interpolation into XML element/attribute
 * content. Prevents XML injection when admin-configured or user-controlled
 * values (entityId, acsUrl, nameId) are interpolated into SAML XML templates.
 */
function escapeXmlValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate SP metadata XML.
 */
export function generateSPMetadata(config: SAMLConfig): string {
  const certClean = config.certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');
  const entityId = escapeXmlValue(config.entityId);
  const acsUrl = escapeXmlValue(config.acsUrl);
  const nameIdFormat = escapeXmlValue(config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT);

  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>${nameIdFormat}</NameIDFormat>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${acsUrl}/sls"/>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0" isDefault="true"/>
    <KeyDescriptor use="signing">
      <KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#">
        <X509Data>
          <X509Certificate>${certClean}</X509Certificate>
        </X509Data>
      </KeyInfo>
    </KeyDescriptor>
  </SPSSODescriptor>
</EntityDescriptor>`;
}

/**
 * Generate an AuthnRequest for SP-initiated SSO.
 */
export function generateAuthnRequest(config: SAMLConfig, relayState?: string): SAMLAuthnRequest {
  const id = `_${randomBytes(16).toString('hex')}`;
  const issueInstant = new Date().toISOString();
  const nameIdFormat = escapeXmlValue(config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT);
  const idpSsoUrl = escapeXmlValue(config.idpSsoUrl);
  const acsUrl = escapeXmlValue(config.acsUrl);
  const entityId = escapeXmlValue(config.entityId);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${idpSsoUrl}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${entityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="${nameIdFormat}" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  const samlRequest = Buffer.from(xml).toString('base64');
  const params = new URLSearchParams({
    SAMLRequest: samlRequest,
    ...(relayState ? { RelayState: relayState } : {}),
  });

  const redirectUrl = `${config.idpSsoUrl}?${params}`;

  return { id, samlRequest, redirectUrl };
}

/**
 * Parse and validate a SAML response from the IdP.
 *
 * This enforces the security-critical checks that were previously missing:
 * - the assertion signature is verified (unless `wantSignedAssertions === false`),
 *   so `parseSAMLResponse` never returns identity from an unsigned/forged response;
 * - the `NotOnOrAfter` condition is enforced, so expired assertions are rejected.
 */
export function parseSAMLResponse(
  samlResponse: string,
  config: SAMLConfig,
): SAMLUserInfo | null {
  let xml: string;
  try {
    xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    return null;
  }

  if (!xml.includes('samlp:Response') && !xml.includes('saml:Assertion')) return null;

  // Obtain the SIGNED, digest-bound assertion and parse every claim from THAT
  // element only. Parsing claims from the whole document (the previous
  // behavior) is vulnerable to signature wrapping: an attacker adds a forged
  // assertion that the regex picks up while a real signed assertion satisfies
  // the signature check elsewhere.
  const assertion = getVerifiedAssertion(samlResponse, config);
  if (!assertion) return null;

  const nameId = extractValue(assertion, 'NameID') ?? '';
  if (!nameId) return null;

  const attributes = extractAttributes(assertion);
  const issuer = extractValue(assertion, 'Issuer') ?? config.idpEntityId;
  // The assertion issuer must match the configured IdP entity id.
  if (config.idpEntityId && issuer !== config.idpEntityId) return null;

  const sessionIndex = extractAttribute(assertion, 'SessionIndex');
  const notOnOrAfter = extractAttribute(assertion, 'NotOnOrAfter');

  // Enforce the assertion's validity window: an expired assertion is rejected.
  const notOnOrAfterMs = notOnOrAfter ? Date.parse(notOnOrAfter) : undefined;
  if (notOnOrAfterMs !== undefined && !Number.isNaN(notOnOrAfterMs) && Date.now() >= notOnOrAfterMs) {
    return null;
  }

  return {
    nameId,
    attributes,
    issuer,
    sessionIndex: sessionIndex ?? undefined,
    notOnOrAfter: notOnOrAfterMs,
  };
}

/**
* Determine the digest algorithm (node crypto name) from a DigestMethod
* Algorithm URI. Falls back to sha256 when absent.
*/
/** Reads the Algorithm attribute from a SignatureMethod/DigestMethod element (null-safe). */
function getAlgorithmUri(el: XmlElementNode | null): string | null {
  return el ? getAttribute(el, 'Algorithm') : null;
}
function digestAlgFromUri(uri: string | null): string {
  if (uri?.includes('sha1')) return 'sha1';
  if (uri?.includes('sha512')) return 'sha512';
  return 'sha256';
}

/**
* Determine the signature algorithm (node crypto name) from a
* SignatureMethod Algorithm URI. Falls back to RSA-SHA256.
*/
function sigAlgFromUri(uri: string | null): string {
  if (uri?.includes('rsa-sha1')) return 'RSA-SHA1';
  if (uri?.includes('rsa-sha512')) return 'RSA-SHA512';
  if (uri?.includes('ecdsa-sha256')) return 'sha256'; // Node verifies ECDSA via generic digest name
  return 'RSA-SHA256';
}

/**
* Verify the response signature and return the exact assertion element the
* signature is bound to (via DigestValue), or null. Among multiple assertions,
* the one whose digest matches is selected — so a forged sibling assertion is
* never returned. When `wantSignedAssertions === false`, returns the first
* assertion without verification.
*
* Supports both signature styles:
* - Response-level signatures whose SignedInfo is signed as raw text and
*   whose DigestValue covers the raw assertion bytes (the PledgeStack style);
* - Assertion-level enveloped signatures (real IdP style): the Signature
*   element lives INSIDE the assertion; the digest is computed over the
*   canonicalized assertion with the Signature element removed, and the
*   SignatureValue covers the canonicalized SignedInfo.
*/
function getVerifiedAssertion(samlResponse: string, config: SAMLConfig): string | null {
  let xml: string;
  try {
    xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    return null;
  }

  if (config.wantSignedAssertions === false) {
    return extractRawElement(xml, 'Assertion');
  }

  const doc = parseXmlDocument(xml);
  if (!doc) return null;

  const signatures = findAllElements(doc, 'Signature');
  if (signatures.length === 0) return null;

  try {
    const publicKey = createPublicKey(config.idpCertificate);

    for (const signature of signatures) {
      const signedInfoEl = findFirstElement(signature, 'SignedInfo');
      const signatureValueEl = findFirstElement(signature, 'SignatureValue');
      const referenceEl = findFirstElement(signature, 'Reference');
      const digestMethodEl = signedInfoEl ? findFirstElement(signedInfoEl, 'DigestMethod') : null;
      const digestValueEl = referenceEl ? findFirstElement(referenceEl, 'DigestValue') : null;
      const signatureMethodEl = signedInfoEl ? findFirstElement(signedInfoEl, 'SignatureMethod') : null;
      if (!signedInfoEl || !signatureValueEl || !digestValueEl || !referenceEl) continue;

      const signatureValue = getTextContent(signatureValueEl);
      const digestValueB64 = getTextContent(digestValueEl);
      if (!signatureValue || !digestValueB64) continue;
      const expected = Buffer.from(digestValueB64, 'base64');
      const digestAlg = digestAlgFromUri(getAlgorithmUri(digestMethodEl));
      const sigAlg = sigAlgFromUri(getAlgorithmUri(signatureMethodEl));

      // 1. Verify the signature over the SignedInfo — try both the raw
      //    extracted text and the canonicalized form (real IdPs sign c14n).
      const signedInfoRaw = rawBytes(signedInfoEl, xml);
      const signatureBytes = Buffer.from(signatureValue, 'base64');
      const signedInfoForms = [signedInfoRaw, c14n(signedInfoEl)];
      let signatureOk = false;
      for (const form of signedInfoForms) {
        try {
          const verify = createVerify(sigAlg);
          verify.update(form);
          verify.end();
          if (verify.verify(publicKey, signatureBytes)) {
            signatureOk = true;
            break;
          }
        } catch {
          // Unsupported algorithm for this form — try the next.
        }
      }
      if (!signatureOk) continue;

      // 2. Determine which element the Reference digest covers. Candidates:
      //    - the element with ID matching the Reference URI (real IdP style);
      //    - every assertion in the document (covers sibling signatures);
      //    - the element containing this signature (enveloped style).
      const candidates: XmlElementNode[] = [];
      const uri = getAttribute(referenceEl, 'URI');
      if (uri && uri.startsWith('#')) {
        const id = uri.slice(1);
        const byId = findElementById(doc, id);
        if (byId) candidates.push(byId);
      }
      for (const assertion of findAllElements(doc, 'Assertion')) {
        candidates.push(assertion);
      }
      if (signature.parent) candidates.push(signature.parent);

      // 3. Compute digests over several byte forms of each candidate:
      //    raw text, canonicalized, and canonicalized with Signature
      //    children stripped (the enveloped-signature transform).
      const digestMatches = (data: string): boolean => {
        const d = createHash(digestAlg).update(data).digest();
        return timingEqual(expected, d);
      };

      for (const candidate of candidates) {
        const forms = [
          rawBytes(candidate, xml),
          c14n(candidate),
          c14n(candidate, true), // enveloped-signature: Signature removed
        ];
        if (!forms.some(digestMatches)) continue;

        if (candidate.local === 'Assertion') {
          return rawBytes(candidate, xml);
        }
        // Signature over a non-assertion element (e.g. the whole Response)
        // is valid for verifySAMLSignature, but parseSAMLResponse needs an
        // assertion — keep looking for an assertion-level match.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Gets the concatenated text content of an element. */
function getTextContent(el: XmlElementNode): string {
  let out = '';
  for (const child of el.children) {
    if (child.type === 'text') out += child.text;
    else if (child.type === 'element') out += getTextContent(child);
  }
  return out.trim();
}

/** Finds the first element (depth-first) with the given ID attribute. */
function findElementById(el: XmlElementNode, id: string): XmlElementNode | null {
  if (getAttribute(el, 'ID') === id || getAttribute(el, 'Id') === id) return el;
  for (const child of el.children) {
    if (child.type === 'element') {
      const found = findElementById(child, id);
      if (found) return found;
    }
  }
  return null;
}


/**
 * Verify the signature on a SAML response using the IdP certificate.
 *
 * SECURITY NOTE: robust SAML assertion verification requires XML canonicalization
 * (C14N) and full XML-DSig reference/digest validation, which cannot be done
 * safely with string matching. This helper is intentionally FAIL-CLOSED: it
 * rejects anything it cannot positively verify. It is not a substitute for a
 * vetted XML-DSig library (e.g. `xml-crypto`) in production — see the package
 * README's SAML section.
 *
 * Fixes vs. the previous version:
 * - `wantSignedAssertions` now defaults to true (`!== false`); an unset value no
 *   longer causes unsigned responses to be accepted.
 * - A missing signature, SignedInfo, DigestValue, or Assertion is rejected.
 * - The SignedInfo's DigestValue is checked against a digest of the Assertion so
 *   the signature is at least bound to an assertion body, not just to SignedInfo.
 */
export function verifySAMLSignature(
  samlResponse: string,
  config: SAMLConfig,
): boolean {
  // Default true: only an explicit `false` opts out of signature enforcement.
  if (config.wantSignedAssertions === false) return true;
  return getVerifiedAssertion(samlResponse, config) !== null;
}

function timingEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Generate a SAML logout request.
 */
export function generateLogoutRequest(
  config: SAMLConfig,
  nameId: string,
  sessionIndex?: string,
  relayState?: string,
): { samlRequest: string; redirectUrl: string } {
  const id = `_${randomBytes(16).toString('hex')}`;
  const issueInstant = new Date().toISOString();

  const sessionXml = sessionIndex
    ? `<samlp:SessionIndex>${escapeXmlValue(sessionIndex)}</samlp:SessionIndex>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${escapeXmlValue(config.idpSsoUrl)}">
  <saml:Issuer>${escapeXmlValue(config.entityId)}</saml:Issuer>
  <saml:NameID Format="${escapeXmlValue(config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT)}">${escapeXmlValue(nameId)}</saml:NameID>
  ${sessionXml}
</samlp:LogoutRequest>`;

  const samlRequest = Buffer.from(xml).toString('base64');
  const params = new URLSearchParams({
    SAMLRequest: samlRequest,
    ...(relayState ? { RelayState: relayState } : {}),
  });

  return { samlRequest, redirectUrl: `${config.idpSsoUrl}?${params}` };
}

function extractValue(xml: string, tag: string): string | null {
  // Allow any namespace prefix (saml:, samlp:, ds: for XML-DSig, etc.) or none.
  const pattern = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([^<]+)</(?:\\w+:)?${tag}>`, 'i');
  const match = xml.match(pattern);
  return match ? match[1].trim() : null;
}

/**
 * Extract a full element including its tag markup (used for digesting the
 * Assertion and reading the SignedInfo bytes). Namespace-prefix agnostic.
 */
function extractRawElement(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<((?:\\w+:)?${tag})[\\s>][\\s\\S]*?</\\1>`, 'i');
  const match = xml.match(pattern);
  return match ? match[0] : null;
}

function extractAttribute(xml: string, attr: string): string | null {
  const match = xml.match(new RegExp(`${attr}="([^"]+)"`, 'i'));
  return match ? match[1] : null;
}

function extractAttributes(xml: string): Record<string, string[]> {
  const attributes: Record<string, string[]> = {};
  const attrRegex = /<saml:Attribute\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/saml:Attribute>/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(xml)) !== null) {
    const name = match[1];
    const valueXml = match[2];
    const values: string[] = [];
    const valueRegex = /<saml:AttributeValue[^>]*>([^<]+)<\/saml:AttributeValue>/g;
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valueRegex.exec(valueXml)) !== null) {
      values.push(valueMatch[1].trim());
    }
    if (values.length > 0) attributes[name] = values;
  }

  return attributes;
}
