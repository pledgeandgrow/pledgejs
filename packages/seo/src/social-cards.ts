import { escapeHtml } from 'pledgestack-shared';

export interface SocialCardInput {
  title: string;
  description: string;
  image?: string;
  url?: string;
  siteName?: string;
  twitterHandle?: string;
  cardType?: 'summary' | 'summary_large_image';
}

export function generateSocialCards(input: SocialCardInput): string {
  const tags: string[] = [];

  tags.push(`<meta property="og:title" content="${escapeHtml(input.title)}">`);
  tags.push(`<meta property="og:description" content="${escapeHtml(input.description)}">`);
  if (input.image) tags.push(`<meta property="og:image" content="${escapeHtml(input.image)}">`);
  if (input.url) tags.push(`<meta property="og:url" content="${escapeHtml(input.url)}">`);
  if (input.siteName) tags.push(`<meta property="og:site_name" content="${escapeHtml(input.siteName)}">`);
  tags.push(`<meta property="og:type" content="website">`);

  tags.push(`<meta name="twitter:card" content="${input.cardType ?? 'summary_large_image'}">`);
  if (input.twitterHandle) tags.push(`<meta name="twitter:site" content="${escapeHtml(input.twitterHandle)}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(input.title)}">`);
  tags.push(`<meta name="twitter:description" content="${escapeHtml(input.description)}">`);
  if (input.image) tags.push(`<meta name="twitter:image" content="${escapeHtml(input.image)}">`);

  return tags.join('\n');
}
