import { describe, it, expect } from 'vitest';
import { getMimeType, staticAssetHeaders, NOSNIFF_HEADERS, MIME_TYPES } from './mime-types';

describe('getMimeType', () => {
  it('returns text/html for .html', () => {
    expect(getMimeType('index.html')).toBe('text/html; charset=utf-8');
  });

  it('returns text/css for .css', () => {
    expect(getMimeType('style.css')).toBe('text/css; charset=utf-8');
  });

  it('returns text/javascript for .js', () => {
    expect(getMimeType('app.js')).toBe('text/javascript; charset=utf-8');
  });

  it('returns application/json for .json', () => {
    expect(getMimeType('data.json')).toBe('application/json; charset=utf-8');
  });

  it('returns image/png for .png', () => {
    expect(getMimeType('logo.png')).toBe('image/png');
  });

  it('returns application/wasm for .wasm', () => {
    expect(getMimeType('module.wasm')).toBe('application/wasm');
  });

  it('returns default MIME type for unknown extension', () => {
    expect(getMimeType('file.unknownext')).toBe('application/octet-stream');
  });

  it('returns default MIME type for no extension', () => {
    expect(getMimeType('noextension')).toBe('application/octet-stream');
  });

  it('is case insensitive', () => {
    expect(getMimeType('IMAGE.PNG')).toBe('image/png');
    expect(getMimeType('Script.JS')).toBe('text/javascript; charset=utf-8');
  });
});

describe('staticAssetHeaders', () => {
  it('includes Content-Type', () => {
    const headers = staticAssetHeaders('style.css');
    expect(headers['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('includes nosniff header', () => {
    const headers = staticAssetHeaders('app.js');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('includes X-Download-Options', () => {
    const headers = staticAssetHeaders('doc.pdf');
    expect(headers['X-Download-Options']).toBe('noopen');
  });
});

describe('NOSNIFF_HEADERS', () => {
  it('has X-Content-Type-Options: nosniff', () => {
    expect(NOSNIFF_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  });
});

describe('MIME_TYPES', () => {
  it('includes common web extensions', () => {
    expect(MIME_TYPES['.html']).toBeDefined();
    expect(MIME_TYPES['.css']).toBeDefined();
    expect(MIME_TYPES['.js']).toBeDefined();
    expect(MIME_TYPES['.json']).toBeDefined();
    expect(MIME_TYPES['.svg']).toBeDefined();
    expect(MIME_TYPES['.woff2']).toBeDefined();
  });
});
