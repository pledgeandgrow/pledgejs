import { describe, it, expect } from 'vitest';
import { sanitizeHtml, sanitizeText, stripHtml, sanitizeInput, sanitizeObject } from './xss';

describe('XSS Protection', () => {
  describe('sanitizeHtml', () => {
    it('escapes HTML special characters', () => {
      expect(sanitizeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;',
      );
    });

    it('escapes ampersand', () => {
      expect(sanitizeHtml('a & b')).toBe('a &amp; b');
    });

    it('escapes backticks', () => {
      expect(sanitizeHtml('`code`')).toBe('&#x60;code&#x60;');
    });

    it('escapes equals sign', () => {
      expect(sanitizeHtml('a=b')).toBe('a&#x3D;b');
    });
  });

  describe('sanitizeText', () => {
    it('escapes basic HTML chars', () => {
      expect(sanitizeText('<b>text</b>')).toBe('&lt;b&gt;text&lt;/b&gt;');
    });

    it('escapes ampersand first', () => {
      expect(sanitizeText('&lt;')).toBe('&amp;lt;');
    });
  });

  describe('stripHtml', () => {
    it('removes HTML tags', () => {
      expect(stripHtml('<p>Hello <b>World</b></p>')).toBe('Hello World');
    });

    it('removes script tags', () => {
      // stripHtml removes tags but leaves content between them
      const result = stripHtml('<script>alert(1)</script>safe');
      expect(result).toBe('alert(1)safe');
    });
  });

  describe('sanitizeInput', () => {
    it('removes script tags', () => {
      expect(sanitizeInput('<script>alert(1)</script>')).toBe('');
    });

    it('removes iframe tags', () => {
      expect(sanitizeInput('<iframe src="evil.com"></iframe>')).toBe('');
    });

    it('removes event handlers', () => {
      expect(sanitizeInput('<div onclick="alert(1)">')).toBe('<div >');
    });

    it('removes javascript: scheme prefix', () => {
      // sanitizeInput removes the scheme but leaves the rest
      expect(sanitizeInput('javascript:alert(1)')).toBe('alert(1)');
    });

    it('removes vbscript: scheme prefix', () => {
      expect(sanitizeInput('vbscript:msgbox(1)')).toBe('msgbox(1)');
    });

    it('preserves safe content', () => {
      expect(sanitizeInput('Hello World')).toBe('Hello World');
    });
  });

  describe('sanitizeObject', () => {
    it('sanitizes string values in objects', () => {
      const result = sanitizeObject({ name: '<script>alert(1)</script>', age: 25 });
      expect(result.name).toBe('');
      expect(result.age).toBe(25);
    });

    it('sanitizes nested objects', () => {
      const result = sanitizeObject({ user: { bio: '<script>x</script>' } });
      expect(result.user.bio).toBe('');
    });

    it('sanitizes arrays of strings', () => {
      const result = sanitizeObject({ tags: ['<script>evil</script>', 'safe'] });
      expect(result.tags[0]).toBe('');
      expect(result.tags[1]).toBe('safe');
    });
  });
});
