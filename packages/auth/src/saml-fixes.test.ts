import { describe, it, expect } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { parseSAMLResponse, type SAMLConfig } from './saml';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config: SAMLConfig = {
  entityId: 'https://sp.example.com',
  acsUrl: 'https://sp.example.com/acs',
  privateKey: '',
  certificate: '',
  idpEntityId: 'idp',
  idpSsoUrl: 'https://idp.example.com/sso',
  idpCertificate: publicKey as string,
};

function sign(assertion: string, rp = 'samlp', ap = 'saml'): string {
  const digest = createHash('sha256').update(assertion).digest('base64');
  const signedInfo = `<ds:SignedInfo><ds:Reference><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const sig = createSign('RSA-SHA256').update(signedInfo).end().sign(privateKey).toString('base64');
  const xml = `<${rp}:Response xmlns:${rp}="urn:oasis:names:tc:SAML:2.0:protocol"><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sig}</ds:SignatureValue></ds:Signature>${assertion}</${rp}:Response>`;
  void ap;
  return Buffer.from(xml).toString('base64');
}

const NS = 'urn:oasis:names:tc:SAML:2.0:assertion';

describe('SAML response handling', () => {
  it('accepts responses using non-"saml"/"samlp" prefixes and extracts their attributes', () => {
    const a = `<saml2:Assertion xmlns:saml2="${NS}"><saml2:Issuer>idp</saml2:Issuer><saml2:Subject><saml2:NameID>u@x.com</saml2:NameID></saml2:Subject><saml2:AttributeStatement><saml2:Attribute Name="role"><saml2:AttributeValue>admin</saml2:AttributeValue></saml2:Attribute></saml2:AttributeStatement></saml2:Assertion>`;
    const info = parseSAMLResponse(sign(a, 'saml2p'), config);
    expect(info?.nameId).toBe('u@x.com');
    expect(info?.attributes.role).toEqual(['admin']);
  });

  it('accepts a prefix-less assertion and extracts attributes', () => {
    const a = `<Assertion xmlns="${NS}"><Issuer>idp</Issuer><Subject><NameID>u@x.com</NameID></Subject><AttributeStatement><Attribute Name="dept"><AttributeValue>eng</AttributeValue></Attribute></AttributeStatement></Assertion>`;
    const info = parseSAMLResponse(sign(a, 'samlp'), config);
    expect(info?.attributes.dept).toEqual(['eng']);
  });

  it('rejects an assertion issued for a different audience (cross-SP replay)', () => {
    const a = (aud: string) => `<saml:Assertion xmlns:saml="${NS}"><saml:Issuer>idp</saml:Issuer><saml:Subject><saml:NameID>u@x.com</saml:NameID></saml:Subject><saml:Conditions><saml:AudienceRestriction><saml:Audience>${aud}</saml:Audience></saml:AudienceRestriction></saml:Conditions></saml:Assertion>`;
    expect(parseSAMLResponse(sign(a('https://other-sp.example.com')), config)).toBeNull();
    expect(parseSAMLResponse(sign(a('https://sp.example.com')), config)?.nameId).toBe('u@x.com');
  });

  it('rejects when ANY NotOnOrAfter is expired, and when NotBefore is in the future', () => {
    const wrap = (inner: string) => `<saml:Assertion xmlns:saml="${NS}"><saml:Issuer>idp</saml:Issuer><saml:Subject><saml:NameID>u@x.com</saml:NameID>${inner}</saml:Subject></saml:Assertion>`;
    const expiredConfirm = wrap(`<saml:SubjectConfirmation><saml:SubjectConfirmationData NotOnOrAfter="2000-01-01T00:00:00Z"/></saml:SubjectConfirmation>`);
    expect(parseSAMLResponse(sign(expiredConfirm), config)).toBeNull();
    const future = `<saml:Assertion xmlns:saml="${NS}"><saml:Issuer>idp</saml:Issuer><saml:Subject><saml:NameID>u@x.com</saml:NameID></saml:Subject><saml:Conditions NotBefore="2999-01-01T00:00:00Z"/></saml:Assertion>`;
    expect(parseSAMLResponse(sign(future), config)).toBeNull();
  });

  it('returns null instead of throwing on pathologically nested XML', () => {
    const xml = '<samlp:Response>' + '<a>'.repeat(50000) + '</a>'.repeat(50000) + '</samlp:Response>';
    expect(parseSAMLResponse(Buffer.from(xml).toString('base64'), config)).toBeNull();
  });
});

describe('SAML SHA-1 handling', () => {
  const assertion = `<saml:Assertion xmlns:saml="${NS}"><saml:Issuer>idp</saml:Issuer><saml:Subject><saml:NameID>u@x.com</saml:NameID></saml:Subject></saml:Assertion>`;

  function signSha1(): string {
    const digest = createHash('sha1').update(assertion).digest('base64');
    const signedInfo = `<ds:SignedInfo><ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><ds:Reference><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
    const sig = createSign('RSA-SHA1').update(signedInfo).end().sign(privateKey).toString('base64');
    const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sig}</ds:SignatureValue></ds:Signature>${assertion}</samlp:Response>`;
    return Buffer.from(xml).toString('base64');
  }

  it('rejects RSA-SHA1 / SHA-1 digests by default', () => {
    expect(parseSAMLResponse(signSha1(), config)).toBeNull();
  });

  it('accepts RSA-SHA1 only when allowSha1 is set', () => {
    const info = parseSAMLResponse(signSha1(), { ...config, allowSha1: true });
    expect(info?.nameId).toBe('u@x.com');
  });
});
