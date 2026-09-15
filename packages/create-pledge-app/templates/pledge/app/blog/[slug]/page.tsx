export default function BlogPostPage({ params }: { params: { slug: string } }) {
  const { slug } = params;
  const posts: Record<string, { title: string; date: string; body: string }> = {
    'hello-pledgestack': {
      title: 'Hello PledgeStack',
      date: '2026-07-17',
      body: 'PledgeStack is a Rust-powered React framework built on PledgePack. PledgePack is a Rust+Zig bundler that eliminates the Node.js bottleneck. The dev server runs natively in Rust, transforms JSX/TSX via Oxc, and pushes HMR updates over WebSocket. No webpack, no babel, no waiting.',
    },
    'rust-dev-server': {
      title: 'Inside the PledgePack Dev Server',
      date: '2026-07-16',
      body: 'PledgePack uses Axum for HTTP, tokio for async I/O, and a native Windows file watcher for change detection. Modules are transformed on-demand with Oxc and served as ESM. Import maps are auto-generated for bare specifiers. The entire pipeline runs in Rust — no Node.js process in sight.',
    },
    'auto-shell-generation': {
      title: 'Auto HTML Shell from JSX',
      date: '2026-07-15',
      body: 'PledgePack parses layout.tsx to extract the HTML shell at the Rust level. The <head> contents — meta tags, title, styles — are converted from JSX to HTML. The entry module is generated in-memory with route-aware code splitting. No index.html, no entry.tsx, no boilerplate.',
    },
  };

  const post = posts[slug];

  if (!post) {
    return (
      <div className="container">
        <div className="not-found">
          <h1>404</h1>
          <p>Blog post not found.</p>
          <a href="/blog" className="btn btn-primary">Back to Blog</a>
        </div>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: '3rem' }}>
      <a href="/blog" style={{ display: 'inline-block', marginBottom: '1rem' }}>← Back to Blog</a>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>{post.title}</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>{post.date}</p>
      <p style={{ fontSize: '1.1rem', lineHeight: 1.8 }}>{post.body}</p>
    </div>
  );
}
