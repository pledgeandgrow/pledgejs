import { describe, it, expect } from 'vitest';
import { generateSitemapXML, routesToSitemapEntries, generateRobotsTxt } from './index';

describe('generateSitemapXML', () => {
  it('generates valid XML for single entry', () => {
    const xml = generateSitemapXML([{ loc: 'https://example.com/' }]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<urlset');
    expect(xml).toContain('<loc>https://example.com/</loc>');
  });

  it('includes optional fields when provided', () => {
    const xml = generateSitemapXML([{
      loc: 'https://example.com/page',
      lastmod: '2024-01-01',
      changefreq: 'daily',
      priority: 0.8,
    }]);
    expect(xml).toContain('<lastmod>2024-01-01</lastmod>');
    expect(xml).toContain('<changefreq>daily</changefreq>');
    expect(xml).toContain('<priority>0.8</priority>');
  });

  it('includes alternate language links', () => {
    const xml = generateSitemapXML([{
      loc: 'https://example.com/page',
      alternates: [
        { hreflang: 'en', href: 'https://example.com/en/page' },
        { hreflang: 'fr', href: 'https://example.com/fr/page' },
      ],
    }]);
    expect(xml).toContain('hreflang="en"');
    expect(xml).toContain('hreflang="fr"');
  });

  it('escapes XML special characters in URLs', () => {
    const xml = generateSitemapXML([{ loc: 'https://example.com/page?q=a&b=c' }]);
    expect(xml).toContain('&amp;');
    expect(xml).not.toContain('q=a&b=c');
  });

  it('handles multiple entries', () => {
    const xml = generateSitemapXML([
      { loc: 'https://example.com/' },
      { loc: 'https://example.com/about' },
      { loc: 'https://example.com/blog' },
    ]);
    expect(xml.match(/<url>/g)?.length).toBe(3);
  });
});

describe('routesToSitemapEntries', () => {
  it('converts routes to sitemap entries', () => {
    const entries = routesToSitemapEntries(['/', '/about', '/blog'], 'https://example.com');
    expect(entries.length).toBe(3);
    expect(entries[0].loc).toBe('https://example.com');
    expect(entries[1].loc).toBe('https://example.com/about');
  });

  it('filters out API routes', () => {
    const entries = routesToSitemapEntries(['/', '/api/users', '/about'], 'https://example.com');
    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.loc.includes('/api'))).toBeUndefined();
  });

  it('filters out dynamic segments', () => {
    const entries = routesToSitemapEntries(['/', '/blog/[slug]', '/about'], 'https://example.com');
    expect(entries.length).toBe(2);
  });

  it('filters excluded patterns', () => {
    const entries = routesToSitemapEntries(['/', '/admin', '/about'], 'https://example.com', {
      exclude: ['/admin'],
    });
    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.loc.includes('/admin'))).toBeUndefined();
  });

  it('applies custom route options', () => {
    const entries = routesToSitemapEntries(['/blog'], 'https://example.com', {
      routes: { '/blog': { priority: 1.0, changefreq: 'hourly' } },
    });
    expect(entries[0].priority).toBe(1.0);
    expect(entries[0].changefreq).toBe('hourly');
  });
});

describe('generateRobotsTxt', () => {
  it('generates default robots.txt', () => {
    const robots = generateRobotsTxt({});
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow:');
  });

  it('includes disallow paths', () => {
    const robots = generateRobotsTxt({ disallow: ['/admin', '/private'] });
    expect(robots).toContain('Disallow: /admin');
    expect(robots).toContain('Disallow: /private');
  });

  it('includes allow paths', () => {
    const robots = generateRobotsTxt({ allow: ['/public'] });
    expect(robots).toContain('Allow: /public');
  });

  it('includes crawl delay', () => {
    const robots = generateRobotsTxt({ crawlDelay: 10 });
    expect(robots).toContain('Crawl-delay: 10');
  });

  it('includes sitemap URL', () => {
    const robots = generateRobotsTxt({ sitemapUrl: 'https://example.com/sitemap.xml' });
    expect(robots).toContain('Sitemap: https://example.com/sitemap.xml');
  });
});
