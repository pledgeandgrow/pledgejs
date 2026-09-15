export default function FeaturesPage() {
  const features = [
    { icon: '🦀', title: 'PledgePack Rust Core', desc: 'PledgePack is a Rust+Zig bundler. Native Oxc parser for JSX/TSX transforms. No webpack, no babel, no Node.js bottleneck.' },
    { icon: '⚡', title: 'Zig Native I/O', desc: 'PledgePack uses pledgepack-native-sys for zero-copy file reads via Zig. No GC pauses, no V8 overhead, just native speed.' },
    { icon: '📁', title: 'File-Based Routing', desc: 'app/page.tsx maps to /. app/blog/[slug]/page.tsx maps to /blog/:slug. Nested layouts, loading states, error boundaries.' },
    { icon: '🔥', title: 'WebSocket HMR', desc: 'PledgePack pushes HMR updates over WebSocket. CSS hot-swap, JS module replacement, cascading deps. No full page reloads.' },
    { icon: '🎨', title: 'Auto HTML Shell', desc: 'PledgePack reads layout.tsx and generates the HTML shell at the Rust level. Extracts <head>, <meta>, <title> from JSX. No index.html needed.' },
    { icon: '📦', title: 'In-Memory Entry', desc: 'Entry module generated at runtime by PledgePack with route-aware code splitting, SPA navigation, and HMR. No entry.tsx file.' },
    { icon: '🔍', title: 'Shell Preview', desc: 'Visit /__pledge_shell to inspect the auto-generated HTML. Debug meta tags, import maps, and script injection.' },
    { icon: '🌐', title: 'Import Maps', desc: 'PledgePack auto-generates import maps for bare specifiers. CJS packages via esm.sh, ESM packages served locally from node_modules.' },
    { icon: '🛡️', title: 'Error Overlay', desc: 'Beautiful error overlay with stack traces and source context. Auto-dismisses on fix. Catches build and runtime errors.' },
    { icon: '🔧', title: 'Oxc Linter', desc: 'PledgePack includes a built-in Oxc linter. Run npx pledge lint — no ESLint config, no plugins, no setup.' },
    { icon: '🏗️', title: 'Production Build', desc: 'npx pledge build bundles and optimizes with PledgePack Rust pipeline. Tree-shaking, minification, and code splitting.' },
    { icon: '�', title: 'API Routes', desc: 'File-based API handlers with GET, POST, PUT, DELETE, PATCH. Create app/api/health/route.ts and export async functions. Zero config.' },
    { icon: '⚠️', title: 'Error Boundaries', desc: 'error.tsx catches runtime errors per-route. loading.tsx shows Suspense fallbacks. not-found.tsx for custom 404 pages.' },
    { icon: '�📱', title: 'Responsive', desc: 'Mobile-first responsive design out of the box. Sticky nav, adaptive grids, and breakpoint-aware styling.' },
  ];

  return (
    <div className="container">
      <section style={{ paddingTop: '3rem' }}>
        <span className="badge">PledgePack Capabilities</span>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>Features</h1>
        <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
          Powered by PledgePack — a Rust+Zig bundler with native transforms, HMR, and zero-config setup.
        </p>
        <div className="grid">
          {features.map((f) => (
            <div className="card">
              <h3><span className="card-icon">{f.icon}</span> {f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
