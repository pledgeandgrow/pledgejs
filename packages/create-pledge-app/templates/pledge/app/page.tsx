export const metadata = {
  title: 'PledgeStack — Rust-Powered React Framework',
  description: 'Build faster with PledgeStack — a Rust-powered React framework with file-based routing, HMR, and zero-config setup.',
  openGraph: {
    title: 'PledgeStack — Rust-Powered React Framework',
    description: 'Build faster with PledgeStack — powered by PledgePack (Rust+Zig bundler).',
  },
};

export default function HomePage() {
  return (
    <div className="container">
      <section className="hero">
        <span className="badge">Powered by PledgePack</span>
        <h1>Build faster with PledgeStack</h1>
        <p>A Rust-powered React framework built on PledgePack — a native bundler with sub-millisecond transforms, file-based routing, HMR, and zero-config setup.</p>
        <div className="hero-actions">
          <a href="/features" className="btn btn-primary">Explore Features</a>
          <a href="/blog" className="btn btn-secondary">Read Blog</a>
        </div>
      </section>

      <section className="grid">
        <div className="card">
          <h3>🦀 PledgePack — Rust Core</h3>
          <p>PledgePack is a Rust+Zig bundler with native Oxc transforms. No Node.js runtime, no webpack, no babel. Just raw speed.</p>
        </div>
        <div className="card">
          <h3>📁 File-Based Routing</h3>
          <p>app/page.tsx → /, app/blog/page.tsx → /blog. Dynamic routes with [slug]. Nested layouts. Zero config.</p>
        </div>
        <div className="card">
          <h3>🔥 WebSocket HMR</h3>
          <p>PledgePack pushes HMR updates over WebSocket. CSS hot-swap, JS module replacement, cascading deps. No full reloads.</p>
        </div>
        <div className="card">
          <h3>🎨 Auto HTML Shell</h3>
          <p>PledgePack reads layout.tsx and generates the HTML shell at the Rust level. No index.html or entry.tsx files needed.</p>
        </div>
        <div className="card">
          <h3>📦 In-Memory Entry</h3>
          <p>Entry module generated at runtime with route-aware code splitting, SPA navigation, and HMR. No static entry file.</p>
        </div>
        <div className="card">
          <h3>🔍 Shell Preview</h3>
          <p>Visit /__pledge_shell to inspect the auto-generated HTML. Debug meta tags, import maps, and script injection.</p>
        </div>
        <div className="card">
          <h3>🌐 Import Maps</h3>
          <p>PledgePack auto-generates import maps for bare specifiers. CJS packages via esm.sh, ESM packages served locally.</p>
        </div>
        <div className="card">
          <h3>🛡️ Error Overlay</h3>
          <p>Beautiful error overlay with stack traces and source context. Auto-dismisses on fix. Catches build and runtime errors.</p>
        </div>
        <div className="card">
          <h3>⚡ Zig I/O</h3>
          <p>PledgePack uses Zig for file I/O via pledgepack-native-sys. Zero-copy reads, native speed, no GC pauses.</p>
        </div>
      </section>

      <section style={{ marginTop: '3rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>Quick Start</h2>
        <div className="code-block">npx create-pledge-app my-app
cd my-app
npx pledge dev</div>
        <p style={{ color: 'var(--muted)', marginTop: '0.5rem', fontSize: '0.85rem' }}>Or with pnpm: <code style={{ color: 'var(--accent)' }}>pnpm dev</code> · <code style={{ color: 'var(--accent)' }}>pnpm build</code></p>
      </section>

      <section style={{ marginTop: '2rem' }}>
        <h2 style={{ marginBottom: '1rem' }}>CLI Commands</h2>
        <div className="grid">
          <div className="card">
            <h3>npx pledge dev</h3>
            <p>Start the PledgePack dev server with HMR, auto-shell, and on-demand transforms.</p>
          </div>
          <div className="card">
            <h3>npx pledge build</h3>
            <p>Production build. Bundles and optimizes with PledgePack's Rust pipeline.</p>
          </div>
          <div className="card">
            <h3>npx pledge lint</h3>
            <p>Lint your project with PledgePack's built-in Oxc linter. No ESLint config needed.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
