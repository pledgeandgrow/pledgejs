import { describe, it, expect } from 'vitest';
import {
  generateJsonLd,
  organizationSchema,
  breadcrumbSchema,
  articleSchema,
  productSchema,
  faqSchema,
  websiteSchema,
} from './jsonld';

describe('generateJsonLd', () => {
  it('generates JSON-LD script tag', () => {
    const jsonld = generateJsonLd({
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Test',
    });
    expect(jsonld).toContain('<script type="application/ld+json">');
    expect(jsonld).toContain('"@type": "Organization"');
    expect(jsonld).toContain('"name": "Test"');
  });
});

describe('organizationSchema', () => {
  it('creates organization schema', () => {
    const schema = organizationSchema({
      name: 'Acme Inc',
      url: 'https://acme.com',
      logo: 'https://acme.com/logo.png',
    });
    expect(schema['@type']).toBe('Organization');
    expect(schema.name).toBe('Acme Inc');
  });
});

describe('breadcrumbSchema', () => {
  it('creates breadcrumb list schema', () => {
    const schema = breadcrumbSchema({
      items: [
        { name: 'Home', url: 'https://example.com' },
        { name: 'Blog', url: 'https://example.com/blog' },
      ],
    });
    expect(schema['@type']).toBe('BreadcrumbList');
    expect(schema.itemListElement).toHaveLength(2);
  });
});

describe('articleSchema', () => {
  it('creates article schema', () => {
    const schema = articleSchema({
      headline: 'Test Article',
      author: 'John Doe',
      datePublished: '2024-01-01',
      publisher: { name: 'Test Pub', url: 'https://example.com' },
    });
    expect(schema['@type']).toBe('Article');
    expect(schema.headline).toBe('Test Article');
  });
});

describe('productSchema', () => {
  it('creates product schema', () => {
    const schema = productSchema({
      name: 'Widget',
      offers: [{ price: '19.99', priceCurrency: 'USD', availability: 'InStock' }],
    });
    expect(schema['@type']).toBe('Product');
    expect(schema.name).toBe('Widget');
  });
});

describe('faqSchema', () => {
  it('creates FAQ schema', () => {
    const schema = faqSchema({
      questions: [
        { question: 'What is this?', answer: 'A test.' },
      ],
    });
    expect(schema['@type']).toBe('FAQPage');
    expect(schema.mainEntity).toHaveLength(1);
  });
});

describe('websiteSchema', () => {
  it('creates website schema', () => {
    const schema = websiteSchema({
      name: 'My Site',
      url: 'https://mysite.com',
    });
    expect(schema['@type']).toBe('WebSite');
    expect(schema.name).toBe('My Site');
  });
});
