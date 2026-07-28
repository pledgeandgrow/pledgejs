const posts: Record<string, { title: string; date: string; body: string[] }> = {
  'hello-pledgestack': {
    title: 'Hello PledgeStack',
    date: '2026-07-17',
    body: [
      'PledgeStack is a Rust-powered React framework built on PledgePack — a Rust+Zig bundler that eliminates the Node.js bottleneck.',
      'The dev server runs natively in Rust, transforms JSX/TSX via Oxc, and pushes HMR updates over WebSocket. No webpack, no babel, no waiting.',
      'This blog post was pre-rendered at build time using PledgeStack\'s Static Site Generation (SSG). The page you\'re reading was generated when `pledge build` ran, not when you requested it.',
    ],
  },
  'static-generation': {
    title: 'Static Generation with SSG',
    date: '2026-07-15',
    body: [
      'PledgeStack pre-renders pages at build time for instant loads. Use `generateStaticParams` to tell PledgeStack which dynamic routes to pre-render.',
      'This page uses `generateStaticParams` to return all blog slugs at build time. PledgeStack then renders each one to a static HTML file.',
      'The result? Your blog posts load instantly — no server round-trip, no rendering, just static HTML served from the edge.',
    ],
  },
  'dynamic-routes': {
    title: 'Dynamic Routes & Metadata',
    date: '2026-07-12',
    body: [
      'Dynamic routes use [slug] in the file path. PledgeStack passes the slug as a `params` prop to your page component.',
      'Use `generateMetadata` to set per-page SEO metadata — title, description, OpenGraph tags. This page generates its own title and description dynamically.',
      'Combine with `generateStaticParams` for fully static, SEO-optimized blog posts that load instantly and rank well in search engines.',
    ],
  },
};

export function generateStaticParams() {
  return Object.keys(posts).map((slug) => ({ slug }));
}

export function generateMetadata({ params }: { params: { slug: string } }) {
  const post = posts[params.slug];
  if (!post) return { title: 'Post not found' };
  return {
    title: `${post.title} — PledgeBlog`,
    description: post.body[0].slice(0, 160),
  };
}

export default function BlogPost({ params }: { params: { slug: string } }) {
  const post = posts[params.slug];

  if (!post) {
    return (
      <div className="container">
        <div className="not-found">
          <h1>404</h1>
          <p>Blog post not found.</p>
          <a href="/blog" style={{ color: 'var(--accent)' }}>← Back to Blog</a>
        </div>
      </div>
    );
  }

  return (
    <div className="container post" style={{ paddingTop: '3rem' }}>
      <a href="/blog" className="back-link">← Back to Blog</a>
      <h1>{post.title}</h1>
      <div className="date">{post.date}</div>
      {post.body.map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </div>
  );
}
