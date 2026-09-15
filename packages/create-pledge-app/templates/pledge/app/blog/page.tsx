export default function BlogPage() {
  const posts = [
    { slug: 'hello-pledgestack', title: 'Hello PledgeStack', date: '2026-07-17', excerpt: 'Why we built PledgePack — a Rust+Zig bundler for React.' },
    { slug: 'rust-dev-server', title: 'Inside the PledgePack Dev Server', date: '2026-07-16', excerpt: 'How PledgePack uses Axum, Oxc, and WebSocket HMR for sub-ms transforms.' },
    { slug: 'auto-shell-generation', title: 'Auto HTML Shell from JSX', date: '2026-07-15', excerpt: 'PledgePack generates index.html from layout.tsx — no static files needed.' },
  ];

  return (
    <div className="container">
      <section style={{ paddingTop: '3rem' }}>
        <span className="badge">Blog</span>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '2rem' }}>Latest Posts</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {posts.map((post) => (
            <a href={`/blog/${post.slug}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
              <h3 style={{ marginBottom: '0.25rem' }}>{post.title}</h3>
              <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>{post.date}</p>
              <p>{post.excerpt}</p>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
