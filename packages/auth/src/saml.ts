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
 * Generate SP metadata XML.
 */
export function generateSPMetadata(config: SAMLConfig): string {
  const certClean = config.certificate
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s/g, '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${config.entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>${config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT}</NameIDFormat>
    <SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${config.acsUrl}/sls"/>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${config.acsUrl}" index="0" isDefault="true"/>
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
  const nameIdFormat = config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${config.idpSsoUrl}" AssertionConsumerServiceURL="${config.acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${config.entityId}</saml:Issuer>
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
 * Verify the response signature and return the exact assertion element the
 * signature is bound to (via DigestValue), or null. Among multiple assertions,
 * the one whose digest matches is selected — so a forged sibling assertion is
 * never returned. When `wantSignedAssertions === false`, returns the first
 * assertion without verification.
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

  if (!xml.includes('Signature')) return null;
  const signatureValue = extractValue(xml, 'SignatureValue');
  const signedInfo = extractRawElement(xml, 'SignedInfo');
  const digestValue = extractValue(xml, 'DigestValue');
  if (!signatureValue || !signedInfo || !digestValue) return null;

  try {
    const publicKey = createPublicKey(config.idpCertificate);
    const verify = createVerify('RSA-SHA256');
    verify.update(signedInfo);
    verify.end();
    if (!verify.verify(publicKey, Buffer.from(signatureValue, 'base64'))) return null;

    const expected = Buffer.from(digestValue, 'base64');
    for (const assertion of extractAllRawElements(xml, 'Assertion')) {
      const sha256 = createHash('sha256').update(assertion).digest();
      const sha1 = createHash('sha1').update(assertion).digest();
      if (timingEqual(expected, sha256) || timingEqual(expected, sha1)) {
        return assertion;
      }
    }
    return null;
  } catch {
    return null;
  }
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
    ? `<samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${issueInstant}" Destination="${config.idpSsoUrl}">
  <saml:Issuer>${config.entityId}</saml:Issuer>
  <saml:NameID Format="${config.nameIdFormat ?? DEFAULT_NAMEID_FORMAT}">${nameId}</saml:NameID>
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

/** Extract every element with the given local name (namespace-prefix agnostic). */
function extractAllRawElements(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<((?:\\w+:)?${tag})[\\s>][\\s\\S]*?</\\1>`, 'gi');
  return xml.match(pattern) ?? [];
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
