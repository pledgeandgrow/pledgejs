/**
 * Path traversal protection — sandbox file access, reject `..` in route paths,
 * validate all fs calls against rootDir.
 */

import { resolve, relative, sep, isAbsolute } from 'node:path';

/** True when `rel` (result of path.relative(root, target)) points outside root. */
function escapesRoot(rel: string): boolean {
  // isAbsolute covers Windows targets on a different drive, where relative()
  // returns the absolute target path instead of a '..' chain.
  return rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../') || isAbsolute(rel);
}

/**
 * Check if a path contains traversal sequences (`..`).
 */
export function containsTraversal(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments.some((s) => s === '..');
}

/**
 * Resolve a path and verify it stays within the sandbox directory.
 * Returns the resolved path if safe, throws if it escapes the sandbox.
 */
export function safeResolve(sandboxDir: string, ...pathSegments: string[]): string {
  const resolved = resolve(sandboxDir, ...pathSegments);
  const rel = relative(sandboxDir, resolved);

  if (escapesRoot(rel)) {
    throw new Error(`Path traversal detected: ${pathSegments.join('/')} escapes sandbox ${sandboxDir}`);
  }

  return resolved;
}

/**
 * Check if a path is within the sandbox directory.
 * Returns true if the path is safe (inside sandbox), false otherwise.
 */
export function isPathSafe(sandboxDir: string, path: string): boolean {
  try {
    const resolved = resolve(sandboxDir, path);
    const rel = relative(sandboxDir, resolved);
    return !escapesRoot(rel);
  } catch {
    return false;
  }
}

/**
 * Sanitize a route path — reject paths containing `..` segments.
 * Returns the sanitized path or null if traversal is detected.
 */
export function sanitizeRoutePath(path: string): string | null {
  if (containsTraversal(path)) return null;

  const normalized = path.replace(/\\/g, '/');
  if (normalized.includes('\0')) return null;

  return normalized;
}

/**
 * Create a sandboxed file access validator.
 * Returns functions to check and resolve paths within a root directory.
 */
export function createFileSandbox(rootDir: string) {
  const normalizedRoot = resolve(rootDir);

  return {
    root: normalizedRoot,

    /** Resolve a path within the sandbox, throwing on traversal */
    resolve(...segments: string[]): string {
      return safeResolve(normalizedRoot, ...segments);
    },

    /** Check if a path is safe without throwing */
    isSafe(path: string): boolean {
      return isPathSafe(normalizedRoot, path);
    },

    /** Assert that a path is safe, throwing if not */
    assertSafe(path: string): void {
      if (!isPathSafe(normalizedRoot, path)) {
        throw new Error(`Path traversal detected: ${path} escapes rootDir ${normalizedRoot}`);
      }
    },
  };
}
