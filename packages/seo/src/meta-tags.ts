import { escapeHtml } from 'pledgestack-shared';

export interface MetaTagInput {
  title?: string;
  description?: string;
  keywords?: string[];
  canonical?: string;
  robots?: string;
  author?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogUrl?: string;
  ogType?: string;
  twitterCard?: 'summary' | 'summary_large_image' | 'player' | 'app';
  twitterSite?: string;
  twitterCreator?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  themeColor?: string;
}

export function generateMetaTags(input: MetaTagInput): string {
  const tags: string[] = [];

  if (input.title) tags.push(`<title>${escapeHtml(input.title)}</title>`);
  if (input.description) tags.push(`<meta name="description" content="${escapeHtml(input.description)}">`);
  if (input.keywords?.length) tags.push(`<meta name="keywords" content="${input.keywords.map(escapeHtml).join(', ')}">`);
  if (input.canonical) tags.push(`<link rel="canonical" href="${escapeHtml(input.canonical)}">`);
  if (input.robots) tags.push(`<meta name="robots" content="${escapeHtml(input.robots)}">`);
  if (input.author) tags.push(`<meta name="author" content="${escapeHtml(input.author)}">`);
  if (input.themeColor) tags.push(`<meta name="theme-color" content="${escapeHtml(input.themeColor)}">`);

  if (input.ogTitle || input.ogDescription || input.ogImage) {
    if (input.ogTitle) tags.push(`<meta property="og:title" content="${escapeHtml(input.ogTitle)}">`);
    if (input.ogDescription) tags.push(`<meta property="og:description" content="${escapeHtml(input.ogDescription)}">`);
    if (input.ogImage) tags.push(`<meta property="og:image" content="${escapeHtml(input.ogImage)}">`);
    if (input.ogUrl) tags.push(`<meta property="og:url" content="${escapeHtml(input.ogUrl)}">`);
    if (input.ogType) tags.push(`<meta property="og:type" content="${escapeHtml(input.ogType)}">`);
  }

  if (input.twitterCard || input.twitterTitle) {
    if (input.twitterCard) tags.push(`<meta name="twitter:card" content="${input.twitterCard}">`);
    if (input.twitterSite) tags.push(`<meta name="twitter:site" content="${escapeHtml(input.twitterSite)}">`);
    if (input.twitterCreator) tags.push(`<meta name="twitter:creator" content="${escapeHtml(input.twitterCreator)}">`);
    if (input.twitterTitle) tags.push(`<meta name="twitter:title" content="${escapeHtml(input.twitterTitle)}">`);
    if (input.twitterDescription) tags.push(`<meta name="twitter:description" content="${escapeHtml(input.twitterDescription)}">`);
    if (input.twitterImage) tags.push(`<meta name="twitter:image" content="${escapeHtml(input.twitterImage)}">`);
  }

  return tags.join('\n');
}
