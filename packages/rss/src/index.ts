/**
 * RSS feed generation for PledgeStack.
 *
 * Provides a generateFeed() API for blog/content sites to generate
 * RSS 2.0 and Atom feeds.
 */

import { escapeXml } from 'pledgestack-shared';

export interface FeedItem {
  title: string;
  description?: string;
  link: string;
  guid?: string;
  pubDate?: string | Date;
  author?: string;
  categories?: string[];
  enclosure?: {
    url: string;
    type: string;
    length?: number;
  };
  custom?: Record<string, string>;
}

export interface FeedOptions {
  title: string;
  description: string;
  link: string;
  language?: string;
  copyright?: string;
  managingEditor?: string;
  webMaster?: string;
  pubDate?: string | Date;
  lastBuildDate?: string | Date;
  categories?: string[];
  generator?: string;
  docs?: string;
  ttl?: number;
  image?: {
    url: string;
    title: string;
    link: string;
    width?: number;
    height?: number;
  };
  items: FeedItem[];
}

/**
 * Generate an RSS 2.0 feed XML string.
 */
export function generateRSSFeed(options: FeedOptions): string {
  const formatDate = (d: string | Date): string => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toUTCString();
  };

  const items = options.items.map((item) => {
    const parts: string[] = ['    <item>'];
    parts.push(`      <title>${escapeXml(item.title)}</title>`);
    if (item.description) parts.push(`      <description>${escapeXml(item.description)}</description>`);
    parts.push(`      <link>${escapeXml(item.link)}</link>`);
    parts.push(`      <guid>${escapeXml(item.guid ?? item.link)}</guid>`);
    if (item.pubDate) parts.push(`      <pubDate>${formatDate(item.pubDate)}</pubDate>`);
    if (item.author) parts.push(`      <author>${escapeXml(item.author)}</author>`);
    if (item.categories) {
      for (const cat of item.categories) {
        parts.push(`      <category>${escapeXml(cat)}</category>`);
      }
    }
    if (item.enclosure) {
      const attrs = [
        `url="${escapeXml(item.enclosure.url)}"`,
        `type="${escapeXml(item.enclosure.type)}"`,
      ];
      if (item.enclosure.length) attrs.push(`length="${item.enclosure.length}"`);
      parts.push(`      <enclosure ${attrs.join(' ')}/>`);
    }
    if (item.custom) {
      for (const [key, value] of Object.entries(item.custom)) {
        parts.push(`      <${key}>${escapeXml(value)}</${key}>`);
      }
    }
    parts.push('    </item>');
    return parts.join('\n');
  }).join('\n');

  const channelParts: string[] = [
    `  <channel>`,
    `    <title>${escapeXml(options.title)}</title>`,
    `    <description>${escapeXml(options.description)}</description>`,
    `    <link>${escapeXml(options.link)}</link>`,
  ];

  if (options.language) channelParts.push(`    <language>${escapeXml(options.language)}</language>`);
  if (options.copyright) channelParts.push(`    <copyright>${escapeXml(options.copyright)}</copyright>`);
  if (options.managingEditor) channelParts.push(`    <managingEditor>${escapeXml(options.managingEditor)}</managingEditor>`);
  if (options.webMaster) channelParts.push(`    <webMaster>${escapeXml(options.webMaster)}</webMaster>`);
  if (options.pubDate) channelParts.push(`    <pubDate>${formatDate(options.pubDate)}</pubDate>`);
  channelParts.push(`    <lastBuildDate>${formatDate(options.lastBuildDate ?? new Date())}</lastBuildDate>`);
  if (options.generator) channelParts.push(`    <generator>${escapeXml(options.generator)}</generator>`);
  if (options.docs) channelParts.push(`    <docs>${escapeXml(options.docs)}</docs>`);
  if (options.ttl) channelParts.push(`    <ttl>${options.ttl}</ttl>`);
  if (options.categories) {
    for (const cat of options.categories) {
      channelParts.push(`    <category>${escapeXml(cat)}</category>`);
    }
  }
  if (options.image) {
    channelParts.push(`    <image>`);
    channelParts.push(`      <url>${escapeXml(options.image.url)}</url>`);
    channelParts.push(`      <title>${escapeXml(options.image.title)}</title>`);
    channelParts.push(`      <link>${escapeXml(options.image.link)}</link>`);
    if (options.image.width) channelParts.push(`      <width>${options.image.width}</width>`);
    if (options.image.height) channelParts.push(`      <height>${options.image.height}</height>`);
    channelParts.push(`    </image>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
${channelParts.join('\n')}
${items}
  </channel>
</rss>`;
}

/**
 * Generate an Atom 1.0 feed XML string.
 */
export function generateAtomFeed(options: FeedOptions): string {
  const formatDate = (d: string | Date): string => {
    const date = typeof d === 'string' ? new Date(d) : d;
    return date.toISOString();
  };

  const entries = options.items.map((item) => {
    const parts: string[] = ['  <entry>'];
    parts.push(`    <title>${escapeXml(item.title)}</title>`);
    parts.push(`    <link href="${escapeXml(item.link)}"/>`);
    parts.push(`    <id>${escapeXml(item.guid ?? item.link)}</id>`);
    if (item.pubDate) parts.push(`    <updated>${formatDate(item.pubDate)}</updated>`);
    if (item.description) parts.push(`    <summary>${escapeXml(item.description)}</summary>`);
    if (item.author) parts.push(`    <author><name>${escapeXml(item.author)}</name></author>`);
    if (item.categories) {
      for (const cat of item.categories) {
        parts.push(`    <category term="${escapeXml(cat)}"/>`);
      }
    }
    parts.push('  </entry>');
    return parts.join('\n');
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(options.title)}</title>
  <subtitle>${escapeXml(options.description)}</subtitle>
  <link href="${escapeXml(options.link)}"/>
  <id>${escapeXml(options.link)}</id>
  <updated>${formatDate(options.lastBuildDate ?? new Date())}</updated>
${entries}
</feed>`;
}

/**
 * Generate a JSON Feed 1.1 string.
 */
export function generateJSONFeed(options: FeedOptions): string {
  return JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: options.title,
    description: options.description,
    home_page_url: options.link,
    feed_url: `${options.link}/feed.json`,
    items: options.items.map((item) => ({
      id: item.guid ?? item.link,
      url: item.link,
      title: item.title,
      content_html: item.description,
      date_published: item.pubDate
        ? (typeof item.pubDate === 'string' ? new Date(item.pubDate) : item.pubDate).toISOString()
        : undefined,
      authors: item.author ? [{ name: item.author }] : undefined,
      tags: item.categories,
    })),
  }, null, 2);
}
