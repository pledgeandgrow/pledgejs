/**
 * Asset fingerprint manifest — maps the stable logical URLs renderers emit
 * (`/__pledge__/client.js`, `/__pledge__/client.css`, `/__pledge__/rsc-client.js`)
 * to the content-hashed filenames the build writes
 * (`/__pledge__/client.9f2c1ab3e4d5f6a7.js`, …).
 *
 * HTML references the hashed URL so browsers/CDNs can cache it immutably;
 * the stable path stays served for compatibility but is never referenced by
 * rendered output once a manifest exists.
 *
 * The manifest is a globalThis-keyed singleton, not module state — the same
 * reason as the renderer registry: the published CLI bundles its own inlined
 * copy of this module via esbuild while renderer adapters are loaded at
 * runtime from node_modules, so module-level state would give each copy its
 * own (empty) manifest and emitters would never see the hashed URLs.
 */

/** Shape of `outDir/__pledge__/asset-manifest.json` written at build time. */
export interface PledgeAssetManifest {
  /** Manifest format version (currently 1). */
  version?: number;
  /** Logical URL path → fingerprinted URL path, e.g. `/__pledge__/client.js` → `/__pledge__/client.<hash>.js`. */
  urls: Record<string, string>;
  /** Fingerprinted URL path → `sha384-…` SRI hash of the served bytes. */
  integrity?: Record<string, string>;
}

const ASSET_MANIFEST_KEY = '__pledgestack_asset_manifest__';

interface AssetManifestGlobal {
  [ASSET_MANIFEST_KEY]?: PledgeAssetManifest | null;
}

/**
 * Installs the active asset manifest for this process. Pass `null` (or a
 * manifest with no `urls`) to restore stable-URL emission — e.g. in dev,
 * where the virtual module serves generated code at the stable paths.
 */
export function setPledgeAssetManifest(manifest: PledgeAssetManifest | null | undefined): void {
  (globalThis as AssetManifestGlobal)[ASSET_MANIFEST_KEY] = manifest ?? null;
}

/** The active asset manifest, or null when none has been installed. */
export function getPledgeAssetManifest(): PledgeAssetManifest | null {
  return (globalThis as AssetManifestGlobal)[ASSET_MANIFEST_KEY] ?? null;
}

/**
 * Resolves a logical framework asset URL to its fingerprinted URL when a
 * manifest is installed; returns the input unchanged otherwise (dev mode,
 * or assets the build did not fingerprint).
 */
export function pledgeAssetUrl(logicalPath: string): string {
  return getPledgeAssetManifest()?.urls?.[logicalPath] ?? logicalPath;
}

/** Clears the installed manifest (test isolation). */
export function resetPledgeAssetManifest(): void {
  delete (globalThis as AssetManifestGlobal)[ASSET_MANIFEST_KEY];
}
