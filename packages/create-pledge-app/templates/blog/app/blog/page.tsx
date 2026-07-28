export default function BlogList() {
  const posts = [
    { slug: 'hello-pledgestack', title: 'Hello PledgeStack', date: '2026-07-17', excerpt: 'Why we built a Rust-powered React framework from scratch.' },
    { slug: 'static-generation', title: 'Static Generation with SSG', date: '2026-07-15', excerpt: 'How PledgeStack pre-renders pages at build time for instant loads.' },
    { slug: 'dynamic-routes', title: 'Dynamic Routes & Metadata', date: '2026-07-12', excerpt: 'Using [slug] params and generateMetadata for per-post SEO.' },
  ];

  return (
    <div className="container">
      <section style={{ paddingTop: '3rem' }}>
        <span className="badge">Blog</span>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '2rem' }}>Latest Posts</h1>
        {posts.map((post) => (
          <a key={post.slug} href={`/blog/${post.slug}`} className="post-card">
            <h3>{post.title}</h3>
            <div className="date">{post.date}</div>
            <div className="excerpt">{post.excerpt}</div>
          </a>
        ))}
      </section>
    </div>
  );
}
