export default function HomePage() {
  return (
    <div className="container">
      <section style={{ paddingTop: '4rem', paddingBottom: '2rem', textAlign: 'center' }}>
        <span className="badge">PledgeBlog</span>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 800, marginBottom: '1rem' }}>
          A blog powered by PledgeStack
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: '1.15rem', maxWidth: '480px', margin: '0 auto 2rem' }}>
          Static generation, dynamic routes, and metadata API — all powered by PledgePack's Rust core.
        </p>
        <a href="/blog" style={{ display: 'inline-block', padding: '.75rem 1.75rem', borderRadius: '10px', fontWeight: 600, background: 'var(--accent)', color: '#fff' }}>
          Read Posts →
        </a>
      </section>
    </div>
  );
}
