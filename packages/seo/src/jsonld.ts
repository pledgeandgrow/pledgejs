export interface JsonLdSchema {
  '@context'?: string;
  '@type': string;
  [key: string]: unknown;
}

export interface Organization {
  name: string;
  url: string;
  logo?: string;
  sameAs?: string[];
  contactPoint?: Array<{ telephone: string; contactType: string; email?: string }>;
}

export interface BreadcrumbList {
  items: Array<{ name: string; url: string }>;
}

export interface Article {
  headline: string;
  author: string | Person;
  datePublished: string;
  dateModified?: string;
  image?: string;
  publisher: Organization;
  description?: string;
  mainEntityOfPage?: string;
}

export interface Product {
  name: string;
  description?: string;
  image?: string;
  brand?: string;
  offers?: Array<{ price: string; priceCurrency: string; availability: string }>;
  aggregateRating?: { ratingValue: string; reviewCount: string };
}

export interface FAQPage {
  questions: Array<{ question: string; answer: string }>;
}

export interface WebSite {
  name: string;
  url: string;
  potentialAction?: { target: string; queryInput: string };
}

export interface Person {
  name: string;
  url?: string;
  sameAs?: string[];
}

export function generateJsonLd(schema: JsonLdSchema): string {
  const data = { '@context': 'https://schema.org', ...schema };
  // Escape characters that could close the <script> tag or introduce HTML
  // parsing ambiguity (</script>, <!--, and the closing tag prefix), so
  // user-controlled schema fields can't break out of the JSON-LD block.
  const json = JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

export function organizationSchema(org: Organization): JsonLdSchema {
  return {
    '@type': 'Organization',
    name: org.name,
    url: org.url,
    ...(org.logo && { logo: { '@type': 'ImageObject', url: org.logo } }),
    ...(org.sameAs && { sameAs: org.sameAs }),
    ...(org.contactPoint && { contactPoint: org.contactPoint.map((cp) => ({ '@type': 'ContactPoint', ...cp })) }),
  };
}

export function breadcrumbSchema(list: BreadcrumbList): JsonLdSchema {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: list.items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function articleSchema(article: Article): JsonLdSchema {
  return {
    '@type': 'Article',
    headline: article.headline,
    author: typeof article.author === 'string' ? { '@type': 'Person', name: article.author } : article.author,
    datePublished: article.datePublished,
    dateModified: article.dateModified ?? article.datePublished,
    publisher: { '@type': 'Organization', name: article.publisher.name, url: article.publisher.url },
    ...(article.image && { image: article.image }),
    ...(article.description && { description: article.description }),
    ...(article.mainEntityOfPage && { mainEntityOfPage: { '@type': 'WebPage', '@id': article.mainEntityOfPage } }),
  };
}

export function productSchema(product: Product): JsonLdSchema {
  return {
    '@type': 'Product',
    name: product.name,
    ...(product.description && { description: product.description }),
    ...(product.image && { image: product.image }),
    ...(product.brand && { brand: { '@type': 'Brand', name: product.brand } }),
    ...(product.offers && {
      offers: product.offers.map((o) => ({ '@type': 'Offer', price: o.price, priceCurrency: o.priceCurrency, availability: o.availability })),
    }),
    ...(product.aggregateRating && {
      aggregateRating: { '@type': 'AggregateRating', ...product.aggregateRating },
    }),
  };
}

export function faqSchema(faq: FAQPage): JsonLdSchema {
  return {
    '@type': 'FAQPage',
    mainEntity: faq.questions.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    })),
  };
}

export function websiteSchema(site: WebSite): JsonLdSchema {
  return {
    '@type': 'WebSite',
    name: site.name,
    url: site.url,
    ...(site.potentialAction && {
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: site.potentialAction.target },
        'query-input': site.potentialAction.queryInput,
      },
    }),
  };
}
