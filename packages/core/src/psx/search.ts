/**
 * Embedded full-text search engine.
 *
 * Uses the rust-search NAPI addon for native inverted index search.
 * When the native addon is not compiled, falls back to a JS Map-based
 * inverted index.
 *
 * No external search service (Elasticsearch, Meilisearch) needed.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface NativeSearch {
  searchAddDocument: (id: string, content: string) => Promise<void>;
  searchRemoveDocument: (id: string) => Promise<void>;
  searchQuery: (query: string, limit?: number) => Promise<SearchResult[]>;
  searchClear: () => Promise<void>;
  searchDocumentCount: () => Promise<number>;
}

export interface SearchResult {
  id: string;
  score: number;
}

let nativeAddon: NativeSearch | null = null;
let loadAttempted = false;

function loadNative(): NativeSearch | null {
  if (loadAttempted) return nativeAddon;
  loadAttempted = true;
  try {
    const addon = require('../../native/rust-search.node') as NativeSearch;
    if (typeof addon.searchAddDocument === 'function') {
      nativeAddon = addon;
    }
  } catch {
    // Addon not compiled
  }
  return nativeAddon;
}

// JS fallback state
const jsDocuments = new Map<string, string>();
const jsInverted = new Map<string, Set<string>>();

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\w]+/).filter((s) => s.length > 0);
}

/**
 * Adds a document to the search index.
 */
export async function searchAddDocument(id: string, content: string): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.searchAddDocument(id, content);
  }

  // Remove old document
  if (jsDocuments.has(id)) {
    const oldContent = jsDocuments.get(id)!;
    for (const token of tokenize(oldContent)) {
      jsInverted.get(token)?.delete(id);
    }
  }

  jsDocuments.set(id, content);
  for (const token of tokenize(content)) {
    if (!jsInverted.has(token)) jsInverted.set(token, new Set());
    jsInverted.get(token)!.add(id);
  }
}

/**
 * Removes a document from the search index.
 */
export async function searchRemoveDocument(id: string): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.searchRemoveDocument(id);
  }

  if (jsDocuments.has(id)) {
    const content = jsDocuments.get(id)!;
    for (const token of tokenize(content)) {
      jsInverted.get(token)?.delete(id);
    }
    jsDocuments.delete(id);
  }
}

/**
 * Searches the index for documents matching the query.
 */
export async function searchQuery(query: string, limit?: number): Promise<SearchResult[]> {
  const addon = loadNative();
  if (addon) {
    return addon.searchQuery(query, limit);
  }

  const tokens = tokenize(query);
  const scores = new Map<string, number>();

  for (const token of tokens) {
    const docIds = jsInverted.get(token);
    if (docIds) {
      for (const docId of docIds) {
        scores.set(docId, (scores.get(docId) ?? 0) + 1);
      }
    }
  }

  const results = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit ?? 10);

  return results;
}

/**
 * Clears the entire search index.
 */
export async function searchClear(): Promise<void> {
  const addon = loadNative();
  if (addon) {
    return addon.searchClear();
  }
  jsDocuments.clear();
  jsInverted.clear();
}

/**
 * Returns the number of documents in the index.
 */
export async function searchDocumentCount(): Promise<number> {
  const addon = loadNative();
  if (addon) {
    return addon.searchDocumentCount();
  }
  return jsDocuments.size;
}

/**
 * Whether the native search engine is available.
 */
export function isNativeSearchAvailable(): boolean {
  return loadNative() !== null;
}
