import type { BundlerAdapter, BundlerType } from 'pledgestack-shared';

/**
 * Resolves a bundler adapter by type.
 *
 * Adapters are lazy-loaded to avoid requiring all bundler packages.
 * Only the selected bundler's package needs to be installed.
 *
 * This function lives in the CLI package (not shared) to avoid
 * circular dependencies between shared and the bundler adapter packages.
 */
export async function resolveBundlerAdapter(
  type: BundlerType,
): Promise<BundlerAdapter> {
  switch (type) {
    case 'pledgepack': {
      const mod = await import('pledgestack-bundler-pledgepack');
      return mod.default as BundlerAdapter;
    }
    case 'vite': {
      const mod = await import('pledgestack-bundler-vite');
      return mod.default as BundlerAdapter;
    }
    case 'rollup': {
      const mod = await import('pledgestack-bundler-rollup');
      return mod.default as BundlerAdapter;
    }
    case 'turbopack': {
      const mod = await import('pledgestack-bundler-turbopack');
      return mod.default as BundlerAdapter;
    }
    case 'rsbuild': {
      const mod = await import('pledgestack-bundler-rsbuild');
      return mod.default as BundlerAdapter;
    }
    case 'webpack': {
      const mod = await import('pledgestack-bundler-webpack');
      return mod.default as BundlerAdapter;
    }
    default: {
      const mod = await import('pledgestack-bundler-pledgepack');
      return mod.default as BundlerAdapter;
    }
  }
}
