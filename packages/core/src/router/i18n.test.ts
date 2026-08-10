import { describe, it, expect } from 'vitest';
import { extractLocale, addLocalePrefix, detectLocale, getI18nPatterns, createTranslator } from './i18n';
import type { I18nConfig } from 'pledgestack-shared';

const config: I18nConfig = {
  locales: ['en', 'fr', 'es'],
  defaultLocale: 'en',
  localePrefix: 'always',
};

const asNeededConfig: I18nConfig = {
  locales: ['en', 'fr', 'es'],
  defaultLocale: 'en',
  localePrefix: 'as-needed',
};

describe('i18n locale extraction (#39)', () => {
  it('extracts locale from pathname with prefix', () => {
    const result = extractLocale('/fr/about', config);
    expect(result).toEqual({ locale: 'fr', pathWithoutLocale: '/about' });
  });

  it('extracts locale from root path', () => {
    const result = extractLocale('/', config);
    expect(result).toEqual({ locale: 'en', pathWithoutLocale: '/' });
  });

  it('returns null for unknown locale with always strategy', () => {
    const result = extractLocale('/de/about', config);
    expect(result).toBeNull();
  });

  it('uses default locale for as-needed strategy', () => {
    const result = extractLocale('/about', asNeededConfig);
    expect(result).toEqual({ locale: 'en', pathWithoutLocale: '/about' });
  });

  it('extracts non-default locale with as-needed strategy', () => {
    const result = extractLocale('/fr/about', asNeededConfig);
    expect(result).toEqual({ locale: 'fr', pathWithoutLocale: '/about' });
  });
});

describe('addLocalePrefix', () => {
  it('adds prefix for non-default locale', () => {
    expect(addLocalePrefix('/about', 'fr', config)).toBe('/fr/about');
  });

  it('does not add prefix for default locale with as-needed', () => {
    expect(addLocalePrefix('/about', 'en', asNeededConfig)).toBe('/about');
  });

  it('handles root path', () => {
    expect(addLocalePrefix('/', 'fr', config)).toBe('/fr');
  });
});

describe('detectLocale', () => {
  it('detects from Accept-Language header', () => {
    expect(detectLocale('fr-FR,fr;q=0.9,en;q=0.8', config)).toBe('fr');
  });

  it('falls back to default locale', () => {
    expect(detectLocale('de,ja', config)).toBe('en');
  });

  it('picks highest quality match', () => {
    expect(detectLocale('en;q=0.8,es;q=0.9', config)).toBe('es');
  });
});

describe('getI18nPatterns', () => {
  it('generates patterns for all locales', () => {
    const patterns = getI18nPatterns('/about', config);
    expect(patterns).toContain('/en/about');
    expect(patterns).toContain('/fr/about');
    expect(patterns).toContain('/es/about');
  });

  it('skips default locale prefix with as-needed', () => {
    const patterns = getI18nPatterns('/about', asNeededConfig);
    expect(patterns).toContain('/about');
    expect(patterns).toContain('/fr/about');
  });
});

describe('createTranslator', () => {
  it('translates keys', () => {
    const t = createTranslator({ hello: 'Bonjour' });
    expect(t('hello')).toBe('Bonjour');
  });

  it('returns key for missing translations', () => {
    const t = createTranslator({});
    expect(t('missing')).toBe('missing');
  });

  it('interpolates parameters', () => {
    const t = createTranslator({ greeting: 'Hello {name}!' });
    expect(t('greeting', { name: 'World' })).toBe('Hello World!');
  });
});
