import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'PledgeStack',
  description: 'A PledgeStack app — Rust-powered React framework',
  themeColor: '#6c63ff',
  openGraph: {
    title: 'PledgeStack',
    description: 'A PledgeStack app — Rust-powered React framework',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#6c63ff',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`* { margin: 0; padding: 0; box-sizing: border-box; } :root { --bg: #0a0a0a; --surface: #111; --border: #222; --text: #e0e0e0; --muted: #888; --accent: #6c63ff; --accent-dim: #4a42b8; --radius: 12px; } body { background: var(--bg); color: var(--text); font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; } a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; } .nav { display: flex; align-items: center; gap: 1rem; padding: 1rem 2rem; background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; } .nav-brand { font-size: 1.25rem; font-weight: 800; color: var(--accent); } .nav-brand:hover { text-decoration: none; } .nav-links { display: flex; gap: 0.5rem; margin-left: auto; } .nav-links a { color: var(--muted); padding: 0.5rem 1rem; border-radius: 8px; transition: all 0.2s; font-size: 0.9rem; font-weight: 500; } .nav-links a:hover { background: var(--border); color: var(--text); text-decoration: none; } .container { max-width: 960px; margin: 0 auto; padding: 2rem; } .hero { text-align: center; padding: 5rem 2rem 4rem; } .hero h1 { font-size: 3.5rem; font-weight: 800; letter-spacing: -0.04em; background: linear-gradient(135deg, var(--accent) 0%, #a78bfa 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 1rem; } .hero p { font-size: 1.25rem; color: var(--muted); max-width: 600px; margin: 0 auto 2rem; } .hero-actions { display: flex; gap: 1rem; justify-content: center; } .btn { display: inline-block; padding: 0.75rem 1.75rem; border-radius: 10px; font-weight: 600; font-size: 0.95rem; transition: all 0.2s; border: none; cursor: pointer; } .btn-primary { background: var(--accent); color: #fff; } .btn-primary:hover { background: var(--accent-dim); text-decoration: none; transform: translateY(-1px); } .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); } .btn-secondary:hover { border-color: var(--accent); text-decoration: none; } .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.5rem; margin-top: 3rem; } .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.75rem; transition: all 0.2s; } .card:hover { border-color: var(--accent-dim); transform: translateY(-2px); } .card h3 { font-size: 1.1rem; margin-bottom: 0.5rem; } .card p { color: var(--muted); font-size: 0.9rem; } .badge { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: rgba(108,99,255,0.15); color: var(--accent); margin-bottom: 1rem; } .code-block { background: #0d0d0d; border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; font-family: monospace; font-size: 0.85rem; overflow-x: auto; margin: 1rem 0; color: #c4b5fd; } .footer { text-align: center; padding: 2rem; color: var(--muted); font-size: 0.85rem; border-top: 1px solid var(--border); margin-top: 4rem; } .not-found { text-align: center; padding: 6rem 2rem; } .not-found h1 { font-size: 6rem; font-weight: 800; color: var(--accent); } .not-found p { color: var(--muted); margin-bottom: 2rem; } @media (max-width: 640px) { .hero h1 { font-size: 2.5rem; } .nav-links { display: none; } .grid { grid-template-columns: 1fr; } }`}</style>
      </head>
      <body>
        <nav className="nav">
          <a href="/" className="nav-brand">PledgeStack</a>
          <div className="nav-links">
            <a href="/">Home</a>
            <a href="/features">Features</a>
            <a href="/blog">Blog</a>
          </div>
        </nav>
        {children}
        <footer className="footer">
          Built with <a href="https://pledgestack.dev">PledgeStack</a> — powered by PledgePack (Rust+Zig)
        </footer>
      </body>
    </html>
  );
}
