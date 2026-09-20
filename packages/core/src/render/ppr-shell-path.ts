/**
 * Single source of truth for where prerendered PPR shells live on disk.
 * Used by the writer (static-export) and the reader (server handler) so the
 * two can never drift.
 *
 * Route patterns contain `/`, `:` and `*`, none of which are safe in file
 * names on every OS (`:` is illegal on Windows / creates NTFS alternate data
 * streams). Every character outside [A-Za-z0-9_.-] is percent-style encoded
 * as `~HH`, which is reversible, collision-free and portable.
 */

function encodeSegment(input: string): string {
  let out = '';
  for (const ch of input) {
    if (/[A-Za-z0-9_.-]/.test(ch)) {
      out += ch;
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += '~' + byte.toString(16).padStart(2, '0');
      }
    }
  }
  return out;
}

const MAX_NAME = 180;

function shortHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2246822519) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/**
 * File name (no directory) of the PPR shell for `pattern`, optionally
 * specialised to concrete route `params` (routes with generateStaticParams).
 * e.g. ('/blog/:slug') -> '~2fblog~2f~3aslug.shell.html'
 */
export function pprShellFileName(pattern: string, params?: Record<string, string>): string {
  let name = pattern === '' || pattern === '/' ? 'index' : encodeSegment(pattern);
  const keys = params ? Object.keys(params).sort() : [];
  if (keys.length > 0) {
    name += '@' + encodeSegment(keys.map((k) => `${k}=${params![k]}`).join('&'));
  }
  if (name.length > MAX_NAME) {
    name = name.slice(0, MAX_NAME - 14) + '-' + shortHash(name);
  }
  return `${name}.shell.html`;
}
