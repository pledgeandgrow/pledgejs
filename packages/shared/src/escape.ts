/**
 * Shared string-escaping helpers. Several packages (og, seo, sitemap, rss,
 * the renderer adapters) each independently reimplemented near-identical
 * versions of these — some missing the apostrophe replacement — so this is
 * the single canonical implementation they all import instead.
 */

/**
 * Escapes a string for safe inclusion in HTML text or a double/single-quoted
 * HTML attribute value.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Escapes a string for safe inclusion in XML text or attribute content
 * (RSS/Atom feeds, sitemap.xml). Uses `&apos;` for apostrophes, the
 * conventional XML entity (HTML uses the numeric `&#39;` instead — see
 * `escapeHtml`).
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
