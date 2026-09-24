/**
 * Render-time security helpers — CSP nonces and SRI integrity stamping.
 *
 * The framework controls the HTML it emits end to end, so it can stamp
 * `nonce`/`integrity` attributes on every <script> tag it generates and
 * mirror the nonce into the Content-Security-Policy header — giving a
 * strict `script-src 'self' 'nonce-…' 'strict-dynamic'` policy with zero
 * user configuration.
 *
 * Lives in pledgestack-shared so every renderer adapter (react/vue/solid/
 * svelte/…) can stamp its own streamed output without depending on
 * pledgestack-core.
 */

import type { RenderSecurity } from './types';

/**
 * Generates a CSP nonce (base64, 128 bits of entropy).
 * Uses globalThis.crypto so it works in Node.js and edge runtimes.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Attribute fragment for a framework-emitted <script> tag.
 * `src` is the tag's src URL, used to look up an SRI hash.
 */
export function scriptSecurityAttrs(security: RenderSecurity | undefined, src?: string): string {
  if (!security) return '';
  let attrs = '';
  if (security.cspNonce) attrs += ` nonce="${security.cspNonce}"`;
  const integrity = src ? security.assetIntegrity?.[src] : undefined;
  if (integrity) attrs += ` integrity="${integrity}"`;
  return attrs;
}

/**
 * <script> `type` values that execute (or are otherwise governed by
 * script-src) and therefore need the CSP nonce. Everything else —
 * application/json, application/ld+json, text/plain, … — is an inert data
 * block; stamping a nonce on those would be harmless but pointless, and
 * skipping them avoids touching raw JSON payloads.
 */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  'module',
  'importmap',
  'speculationrules',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
]);

function isExecutableScript(attrs: string): boolean {
  const type = /\btype\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
  // No type attribute → classic script → executable.
  if (type === undefined) return true;
  return EXECUTABLE_SCRIPT_TYPES.has(type.toLowerCase().trim());
}

/**
 * Framework bootstrap assignments (`window.__PLEDGE_ROUTE__={...}`,
 * `window.__PLEDGE_ENV__ = {...};`) that renderers emit without threading the
 * security context. Recognised only when the right-hand side parses as pure
 * JSON, so an attacker-injected `<script>window.__PLEDGE_ROUTE__=1;alert(1)`
 * can never borrow the framework's nonce.
 */
const FRAMEWORK_DATA_ASSIGN = /^\s*window\.__PLEDGE_(?:ROUTE|ENV|DEHYDRATED)__\s*=\s*([\s\S]*?);?\s*$/;

function isFrameworkInlineData(body: string): boolean {
  const m = FRAMEWORK_DATA_ASSIGN.exec(body);
  if (!m) return false;
  try {
    JSON.parse(m[1]!);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the script is emitted by the framework itself and may therefore
 * carry the per-request nonce: a same-origin framework asset
 * (`/__pledge__/…` or a src the build registered in `assetIntegrity`), or a
 * framework JSON-assignment bootstrap. User-authored, plugin-injected and
 * attacker-injected scripts are deliberately NOT stamped — a blanket nonce
 * would turn a markup-injection bug into full CSP bypass.
 */
function isFrameworkScript(attrs: string, body: string | undefined, security: RenderSecurity): boolean {
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
  if (src !== undefined) {
    return src.startsWith('/__pledge__/') || (security.assetIntegrity !== undefined && src in security.assetIntegrity);
  }
  return body !== undefined && isFrameworkInlineData(body);
}

/**
 * Stamps nonce/bintegrityson the framework-emitted executable <script> tags of
 * a rendered HTML document, and integrity on framework assets.
 *
 * Only framework scripts get the nonce (see isFrameworkScript). Scripts the
 * framework emits from its own emit sites already carry `nonce` via
 * scriptSecurityAttrs and are left as-is. Data blocks (application/json,
 * application/ld+json, …) are left alone — they don't execute and their raw
 * text must not be modified.
 *
 * Note on data-block contents: a `<script` substring inside a JSON string
 * value still gets matched here (JSON.stringify doesn't escape `<`), which
 * would corrupt the payload. Framework emit sites escape `<` via
 * escapeJsonForScript, preventing both that corruption and `</script>`
 * breakout.
 */
export function applyScriptSecurity(html: string, security: RenderSecurity | undefined): string {
  if (!security?.cspNonce && !security?.assetIntegrity) return html;
  return html
    .replace(/<script\b([^>]*)>/gi, (match, attrs: string, offset: number) => {
      let extra = '';
      if (isExecutableScript(attrs)) {
        const rest = html.slice(offset + match.length);
        const end = rest.search(/<\/script/i);
        const body = end === -1 ? undefined : rest.slice(0, end);
        if (isFrameworkScript(attrs, body, security)) {
          if (security.cspNonce && !/\bnonce\s*=/i.test(attrs)) {
            extra += ` nonce="${security.cspNonce}"`;
          }
          const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
          const integrity = src ? security.assetIntegrity?.[src] : undefined;
          if (integrity && !/\bintegrity\s*=/i.test(attrs)) {
            extra += ` integrity="${integrity}"`;
          }
        }
      }
      return extra ? `<script${extra}${attrs}>` : match;
    })
    // <link> subresources (framework-emitted stylesheets like
    // /__pledge__/client.css) get integrity="sha384-…" too.
    .replace(/<link\b([^>]*)>/gi, (match, attrs: string) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const integrity = href ? security.assetIntegrity?.[href] : undefined;
      if (!integrity || /\bintegrity\s*=/i.test(attrs)) return match;
      return `<link integrity="${integrity}"${attrs}>`;
    });
}

/**
 * Escapes a JSON payload for safe embedding inside an inline <script>
 * block: `<` → `<` prevents `</script>` breakout and stops
 * applyScriptSecurity from matching tag-like substrings inside the data.
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/</g, '\\u003c');
}

/**
 * Extracts the exact byte content of every executable inline <script> body
 * in an HTML document. External scripts (`src=`) and inert data blocks
 * (application/json, …) are excluded — they're governed by 'self' or don't
 * execute at all.
 */
export function extractInlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1]!;
    const body = m[2]!;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (!isExecutableScript(attrs)) continue;
    if (body.trim() === '') continue;
    bodies.push(body);
  }
  return bodies;
}

/**
 * CSP `script-src` hash sources (`'sha256-…'`) for every inline script in
 * the document — the alternative to nonces for HTML that is shared across
 * requests (ISR cache, prerendered pages): the bytes are frozen, so the
 * hashes stay valid. Uses WebCrypto, so it works in Node 20+ and edge
 * runtimes.
 */
export async function inlineScriptHashes(html: string): Promise<string[]> {
  const bodies = extractInlineScriptBodies(html);
  const hashes: string[] = [];
  const encoder = new TextEncoder();
  for (const body of bodies) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(body));
    let binary = '';
    for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
    hashes.push(`'sha256-${btoa(binary)}'`);
  }
  return hashes;
}

/**
 * Finds cross-origin <script src>/<link href> references in emitted HTML
 * that carry no `integrity` attribute. Third-party subresources without
 * SRI execute with full page privilege if the CDN is compromised — the
 * build surfaces these as warnings so developers can add integrity (or
 * self-host).
 */
export function findExternalAssetsWithoutIntegrity(html: string): string[] {
  const flagged: string[] = [];
  const scan = (tagRe: RegExp, attrRe: RegExp) => {
    for (const match of html.matchAll(tagRe)) {
      const attrs = match[1]!;
      const url = attrRe.exec(attrs)?.[1];
      if (!url || !/^https?:\/\//i.test(url)) continue;
      if (/\bintegrity\s*=/i.test(attrs)) continue;
      flagged.push(url);
    }
  };
  scan(/<script\b([^>]*)>/gi, /\bsrc\s*=\s*["']([^"']+)["']/i);
  scan(/<link\b([^>]*)>/gi, /\bhref\s*=\s*["']([^"']+)["']/i);
  return flagged;
}
