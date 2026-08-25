import { describe, it, expect } from 'vitest';
import { generateRSSFeed, generateAtomFeed } from './index';

const base = { title: 'Feed', description: 'desc', link: 'https://ex.com' };

describe('RSS guid isPermaLink (#rss)', () => {
  it('marks a custom (non-URL) guid as isPermaLink="false"', () => {
    const xml = generateRSSFeed({ ...base, items: [{ title: 'A', link: 'https://ex.com/a', guid: 'uuid-123' }] });
    expect(xml).toContain('<guid isPermaLink="false">uuid-123</guid>');
  });

  it('marks a link-derived guid as isPermaLink="true"', () => {
    const xml = generateRSSFeed({ ...base, items: [{ title: 'A', link: 'https://ex.com/a' }] });
    expect(xml).toContain('<guid isPermaLink="true">https://ex.com/a</guid>');
  });
});

describe('Atom feed validity (#atom)', () => {
  it('emits <updated> for every entry even without pubDate', () => {
    const xml = generateAtomFeed({ ...base, items: [{ title: 'A', link: 'https://ex.com/a' }] });
    const entryBlock = xml.slice(xml.indexOf('<entry>'), xml.indexOf('</entry>'));
    expect(entryBlock).toContain('<updated>');
  });

  it('emits a feed-level <author>', () => {
    const xml = generateAtomFeed({ ...base, managingEditor: 'ed@ex.com', items: [] });
    expect(xml).toContain('<author><name>ed@ex.com</name></author>');
  });
});
