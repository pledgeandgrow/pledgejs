import { describe, it, expect } from 'vitest';
import { generateStaticPages } from './static';
import type { ResolvedRoute, PledgeConfig } from 'pledgestack-shared';
import type { PageModule } from '../router/types';

function route(pattern: string, extra: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    filePath: `/app${pattern}/page.tsx`,
    pattern,
    mode: 'ssr',
    runtime: 'node',
    isLayout: false,
    isErrorBoundary: false,
    isLoading: false,
    isNotFound: false,
    ...extra,
  } as ResolvedRoute;
}

const config = {} as PledgeConfig;

describe('generateStaticPages', () => {
  it('skips dynamic routes without generateStaticParams instead of crashing', async () => {
    // Regression: scaffolded apps ship /blog/[slug] pages that destructure
    // `params` — rendering them with `{}` threw "Cannot destructure property
    // 'slug' of 'params' as it is undefined" and failed the whole build.
    const dynamic = route('/blog/:slug', { filePath: '/app/blog/[slug]/page.tsx' });
    const modules = new Map<string, PageModule>([
      [
        dynamic.filePath,
        {
          default: ({ params }: { params: { slug: string } }) => {
            const { slug } = params;
            return slug;
          },
        } as unknown as PageModule,
      ],
    ]);

    const out = await generateStaticPages({ config, routes: [dynamic], modules });
    expect(out.size).toBe(0);
  });

  it('prerenders dynamic routes via generateStaticParams with { params } props', async () => {
    const dynamic = route('/blog/:slug', { filePath: '/app/blog/[slug]/page.tsx' });
    const modules = new Map<string, PageModule>([
      [
        dynamic.filePath,
        {
          default: ({ params }: { params: { slug: string } }) => `post:${params.slug}`,
          generateStaticParams: async () => [{ slug: 'hello' }, { slug: 'world' }],
        } as unknown as PageModule,
      ],
    ]);

    const out = await generateStaticPages({ config, routes: [dynamic], modules });
    expect([...out.keys()].sort()).toEqual(['/blog/hello', '/blog/world']);
    expect(out.get('/blog/hello')).toContain('post:hello');
  });

  it('renders static routes', async () => {
    const home = route('/', { filePath: '/app/page.tsx' });
    const modules = new Map<string, PageModule>([
      [home.filePath, { default: () => 'home' } as unknown as PageModule],
    ]);

    const out = await generateStaticPages({ config, routes: [home], modules });
    expect(out.get('/')).toContain('home');
  });
});
