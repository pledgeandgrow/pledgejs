import { describe, it, expect } from 'vitest';
import { generateRSSFeed, generateAtomFeed, generateJSONFeed, type FeedItem } from 'pledgestack-rss';

const items: FeedItem[] = [
  { title: 'First Post', link: 'https://example.com/1', description: 'My first post', pubDate: new Date('2024-01-01') },
  { title: 'Second Post', link: 'https://example.com/2', description: 'My second post', pubDate: new Date('2024-01-02') },
];

const feedOpts = { title: 'Test Feed', description: 'A test feed', link: 'https://example.com', items };

describe('RSS Feed Generation (#18)', () => {
  it('generates RSS 2.0 feed', () => {
    const xml = generateRSSFeed(feedOpts);
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<rss');
    expect(xml).toContain('<channel>');
    expect(xml).toContain('Test Feed');
    expect(xml).toContain('First Post');
    expect(xml).toContain('Second Post');
  });

  it('generates Atom feed', () => {
    const xml = generateAtomFeed(feedOpts);
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<feed');
    expect(xml).toContain('xmlns');
    expect(xml).toContain('Test Feed');
  });

  it('generates JSON feed', () => {
    const json = generateJSONFeed(feedOpts);
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe('Test Feed');
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].title).toBe('First Post');
  });

  it('includes item links in RSS', () => {
    const xml = generateRSSFeed(feedOpts);
    expect(xml).toContain('https://example.com/1');
    expect(xml).toContain('https://example.com/2');
  });

  it('handles empty items list', () => {
    const xml = generateRSSFeed({ ...feedOpts, items: [] });
    expect(xml).toContain('<rss');
  });
});
