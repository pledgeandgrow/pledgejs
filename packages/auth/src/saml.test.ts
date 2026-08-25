import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { parseSAMLResponse, verifySAMLSignature, type SAMLConfig } from './saml';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const idpCertPem = publicKey as string;

const baseConfig: SAMLConfig = {
  entityId: 'sp',
  acsUrl: 'https://sp.example.com/acs',
  privateKey: '',
  certificate: '',
  idpEntityId: 'idp',
  idpSsoUrl: 'https://idp.example.com/sso',
  idpCertificate: idpCertPem,
};

/** Build a base64-encoded SAML Response with a valid signature over SignedInfo + digest of the assertion. */
function buildSignedResponse(nameId: string, notOnOrAfter?: string): string {
  const cond = notOnOrAfter ? `<saml:Conditions NotOnOrAfter="${notOnOrAfter}"/>` : '';
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>idp</saml:Issuer>${cond}<saml:Subject><saml:NameID>${nameId}</saml:NameID></saml:Subject></saml:Assertion>`;
  const digest = createHash('sha256').update(assertion).digest('base64');
  const signedInfo = `<ds:SignedInfo><ds:Reference><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const signature = createSign('RSA-SHA256').update(signedInfo).end().sign(privateKey).toString('base64');
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${signature}</ds:SignatureValue></ds:Signature>${assertion}</samlp:Response>`;
  return Buffer.from(xml).toString('base64');
}

describe('SAML signature verification (fail-closed)', () => {
  it('rejects an unsigned response (no auth bypass)', () => {
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Subject><saml:NameID>attacker@evil.com</saml:NameID></saml:Subject></saml:Assertion></samlp:Response>`;
    const b64 = Buffer.from(xml).toString('base64');
    expect(verifySAMLSignature(b64, baseConfig)).toBe(false);
    expect(parseSAMLResponse(b64, baseConfig)).toBeNull();
  });

  it('rejects unsigned even when wantSignedAssertions is left undefined', () => {
    const cfg = { ...baseConfig };
    delete (cfg as any).wantSignedAssertions;
    const xml = `<samlp:Response><saml:Assertion><saml:NameID>x</saml:NameID></saml:Assertion></samlp:Response>`;
    expect(verifySAMLSignature(Buffer.from(xml).toString('base64'), cfg)).toBe(false);
  });

  it('verifies a genuinely signed response and returns the NameID', () => {
    const signed = buildSignedResponse('alice@example.com');
    expect(verifySAMLSignature(signed, baseConfig)).toBe(true);
    const info = parseSAMLResponse(signed, baseConfig);
    expect(info?.nameId).toBe('alice@example.com');
  });

  it('rejects a signed response whose assertion body was swapped after signing', () => {
    const signed = buildSignedResponse('alice@example.com');
    const xml = Buffer.from(signed, 'base64').toString('utf8').replace('alice@example.com', 'attacker@evil.com');
    const tampered = Buffer.from(xml).toString('base64');
    // DigestValue no longer matches the swapped assertion → rejected.
    expect(verifySAMLSignature(tampered, baseConfig)).toBe(false);
  });

  it('rejects an expired assertion (NotOnOrAfter in the past)', () => {
    const signed = buildSignedResponse('alice@example.com', '2000-01-01T00:00:00Z');
    expect(parseSAMLResponse(signed, baseConfig)).toBeNull();
  });

  it('resists signature wrapping — a forged sibling assertion does not grant identity', () => {
    // Take a validly-signed response and inject a forged (unsigned) assertion
    // before the real one. Claims must come from the digest-bound assertion.
    const signed = buildSignedResponse('alice@example.com');
    const xml = Buffer.from(signed, 'base64').toString('utf8');
    const forged = '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>idp</saml:Issuer><saml:Subject><saml:NameID>attacker@evil.com</saml:NameID></saml:Subject></saml:Assertion>';
    // Insert the forged assertion right after the opening Response tag.
    const wrapped = xml.replace('>', '>' + forged, 1);
    const info = parseSAMLResponse(Buffer.from(wrapped).toString('base64'), baseConfig);
    // Either rejected, or (if it verifies) the identity is the REAL one, never the forged one.
    expect(info?.nameId).not.toBe('attacker@evil.com');
  });

  it('rejects an assertion whose issuer does not match the configured IdP', () => {
    const signed = buildSignedResponse('alice@example.com');
    expect(parseSAMLResponse(signed, { ...baseConfig, idpEntityId: 'different-idp' })).toBeNull();
  });

  it('accepts a non-expired assertion (NotOnOrAfter in the future)', () => {
    const signed = buildSignedResponse('alice@example.com', '2999-01-01T00:00:00Z');
    expect(parseSAMLResponse(signed, baseConfig)?.nameId).toBe('alice@example.com');
  });
});
