import type { PledgePlugin } from 'pledgestack-shared';

/**
 * MDX plugin for PledgeStack.
 *
 * This is a framework-level plugin that registers as a pledgepack plugin
 * via the transform hook. PledgePack's transform pipeline handles the actual
 * MDX → JS compilation. This plugin configures the transform and provides
 * the component wrapper that renders MDX content as React components.
 *
 * Usage in pledge.config.ts:
 * ```typescript
 * import { defineConfig } from 'pledge';
 * import { mdxPlugin } from 'pledgestack-mdx';
 *
 * export default defineConfig({
 *   plugins: [mdxPlugin()],
 * });
 * ```
 */

export interface MDXPluginOptions {
  /** File extensions to process (default: ['.mdx', '.md']). Honored by isMDXFile. */
  extensions?: string[];
  /** Provider component for MDX context (optional) */
  provider?: string;
  /**
   * Extract frontmatter before compiling (default: true). Forwarded to
   * config.mdx.frontmatter and honored by the JS transform pipeline.
   */
  frontmatter?: boolean;
  /**
   * remark plugin names/paths, forwarded to config.mdx.remarkPlugins for
   * PledgePack's MDX transform. The JS fallback pipeline does not run remark
   * plugins — they take effect when compiling through PledgePack.
   */
  remarkPlugins?: string[];
  /**
   * rehype plugin names/paths, forwarded to config.mdx.rehypePlugins for
   * PledgePack's MDX transform. The JS fallback pipeline does not run rehype
   * plugins — they take effect when compiling through PledgePack.
   */
  rehypePlugins?: string[];
}

const DEFAULT_EXTENSIONS = ['.mdx', '.md'];

export function mdxPlugin(options: MDXPluginOptions = {}): PledgePlugin {
  return {
    name: 'pledgestack-mdx',

    configResolved(config) {
      // Ensure pledgepack knows about .mdx files
      if (!config.appDir) return;
      // Forward MDX options through the resolved config so PledgePack's MDX
      // transform (and the JS fallback pipeline) can read them. Previously
      // these options were accepted but silently ignored.
      config.mdx = {
        frontmatter: options.frontmatter ?? true,
        remarkPlugins: options.remarkPlugins,
        rehypePlugins: options.rehypePlugins,
      };
    },

    transformClientBundle(code) {
      // Inject MDX provider wrapper if configured
      if (options.provider && code.includes('__pledge_mdx_provider__')) {
        return code.replace(
          '__pledge_mdx_provider__',
          options.provider,
        );
      }
      return code;
    },
  };
}

/**
 * Helper to create an MDX page entry.
 * In the app directory, .mdx files are automatically treated as page components.
 * This helper provides type safety for MDX page exports.
 */
export interface MDXPageProps {
  [key: string]: unknown;
}

export interface MDXPageMeta {
  title?: string;
  description?: string;
  date?: string;
  tags?: string[];
  draft?: boolean;
}

/**
 * Extract frontmatter from raw MDX content.
 * This is a simple parser — PledgePack's transform pipeline does the full parsing.
 */
export function extractFrontmatter(source: string): { frontmatter: Record<string, unknown>; content: string } {
  // Accept CRLF (Windows checkouts) and a closing fence with no trailing body.
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    return { frontmatter: {}, content: source };
  }

  const frontmatterText = match[1];
  const content = match[2] ?? '';
  const frontmatter: Record<string, unknown> = {};

  for (const line of frontmatterText.split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // Parse simple values
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === 'null') value = null;
    else if (/^\d+$/.test(value as string)) value = Number(value);
    else if ((value as string).startsWith('[') && (value as string).endsWith(']')) {
      value = (value as string)
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      // Remove surrounding quotes
      value = (value as string).replace(/^["']|["']$/g, '');
    }

    if (key === '__proto__') continue;
    frontmatter[key] = value;
  }

  return { frontmatter, content };
}

/**
 * Check if a file path is an MDX file. Pass the configured `extensions` (from
 * MDXPluginOptions) to honor a custom set; defaults to ['.mdx', '.md'].
 */
export function isMDXFile(filePath: string, extensions: string[] = DEFAULT_EXTENSIONS): boolean {
  return extensions.some((ext) => filePath.endsWith(ext));
}
