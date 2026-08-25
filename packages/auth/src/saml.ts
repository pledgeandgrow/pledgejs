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

  // Reject anything whose signature does not verify before trusting its claims.
  if (!verifySAMLSignature(samlResponse, config)) return null;

  const nameId = extractValue(xml, 'NameID') ?? '';
  if (!nameId) return null;

  const attributes = extractAttributes(xml);
  const issuer = extractValue(xml, 'Issuer') ?? config.idpEntityId;
  const sessionIndex = extractAttribute(xml, 'SessionIndex');
  const notOnOrAfter = extractAttribute(xml, 'NotOnOrAfter');

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

  let xml: string;
  try {
    xml = Buffer.from(samlResponse, 'base64').toString('utf8');
  } catch {
    return false;
  }

  if (!xml.includes('Signature')) return false;

  const signatureValue = extractValue(xml, 'SignatureValue');
  const signedInfo = extractRawElement(xml, 'SignedInfo');
  const digestValue = extractValue(xml, 'DigestValue');
  const assertion = extractRawElement(xml, 'Assertion');

  if (!signatureValue || !signedInfo || !digestValue || !assertion) return false;

  try {
    // 1. The signature must verify over the SignedInfo element.
    const publicKey = createPublicKey(config.idpCertificate);
    const verify = createVerify('RSA-SHA256');
    verify.update(signedInfo);
    verify.end();
    const sigOk = verify.verify(publicKey, Buffer.from(signatureValue, 'base64'));
    if (!sigOk) return false;

    // 2. The DigestValue in SignedInfo must match a digest of the assertion,
    //    binding the signature to the assertion body (defends against body
    //    substitution where a valid SignedInfo is reused with a swapped
    //    assertion). Both SHA-256 and SHA-1 references are accepted.
    const expected = Buffer.from(digestValue, 'base64');
    const sha256 = createHash('sha256').update(assertion).digest();
    const sha1 = createHash('sha1').update(assertion).digest();
    return timingEqual(expected, sha256) || timingEqual(expected, sha1);
  } catch {
    return false;
  }
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
