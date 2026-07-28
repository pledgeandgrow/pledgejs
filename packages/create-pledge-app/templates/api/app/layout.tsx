import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'PledgeStack API',
  description: 'PledgeStack API Server — REST API with CRUD routes',
  themeColor: '#10b981',
  openGraph: {
    title: 'PledgeStack API',
    description: 'PledgeStack API Server — REST API with CRUD routes',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#10b981',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0a;--surface:#111;--border:#222;--text:#e0e0e0;--muted:#888;--accent:#10b981;--accent-dim:#059669;--radius:12px}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.7}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.nav{display:flex;align-items:center;gap:1rem;padding:1rem 2rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}.nav-brand{font-size:1.25rem;font-weight:800;color:var(--accent)}.nav-brand:hover{text-decoration:none}.nav-links{display:flex;gap:.5rem;margin-left:auto}.nav-links a{color:var(--muted);padding:.5rem 1rem;border-radius:8px;font-size:.9rem;font-weight:500;transition:all .2s}.nav-links a:hover{background:var(--border);color:var(--text);text-decoration:none}.container{max-width:720px;margin:0 auto;padding:2rem}.footer{text-align:center;padding:2rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}.endpoint{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:.75rem;transition:border-color .2s}.endpoint:hover{border-color:var(--accent)}.method{display:inline-block;padding:.25rem .6rem;border-radius:6px;font-size:.75rem;font-weight:700;min-width:56px;text-align:center}.method.GET{background:#05966933;color:#10b981}.method.POST{background:#6366f133;color:#818cf8}.method.DELETE{background:#ef444433;color:#ef4444}.method.PATCH{background:#eab30833;color:#eab308}.endpoint .path{font-family:monospace;font-size:.95rem;color:var(--text)}.endpoint .desc{margin-left:auto;color:var(--muted);font-size:.85rem}.code-block{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;font-family:monospace;font-size:.85rem;line-height:1.8;overflow-x:auto;margin:1rem 0}.code-block .key{color:var(--accent)}.code-block .str{color:#fbbf24}.code-block .comment{color:var(--muted)}`}</style>
      </head>
      <body>
        <nav className="nav">
          <a href="/" className="nav-brand">PledgeAPI</a>
          <div className="nav-links">
            <a href="/">Docs</a>
            <a href="/api/items">/api/items</a>
          </div>
        </nav>
        {children}
        <footer className="footer">
          Built with <a href="https://pledgestack.dev">PledgeStack</a> — API routes powered by PledgePack (Rust+Zig)
        </footer>
      </body>
    </html>
  );
}
