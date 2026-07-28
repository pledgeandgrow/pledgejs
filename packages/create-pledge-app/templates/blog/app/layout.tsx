import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'PledgeBlog — A PledgeStack Blog',
  description: 'A blog built with PledgeStack showcasing SSG, dynamic routes, and metadata API.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="description" content="A blog built with PledgeStack — Rust-powered React framework" />
        <meta name="theme-color" content="#6c63ff" />
        <title>PledgeBlog</title>
        <style>{`*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0a;--surface:#111;--border:#222;--text:#e0e0e0;--muted:#888;--accent:#6c63ff;--accent-dim:#4a42b8;--radius:12px}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.7}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.nav{display:flex;align-items:center;gap:1rem;padding:1rem 2rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}.nav-brand{font-size:1.25rem;font-weight:800;color:var(--accent)}.nav-brand:hover{text-decoration:none}.nav-links{display:flex;gap:.5rem;margin-left:auto}.nav-links a{color:var(--muted);padding:.5rem 1rem;border-radius:8px;font-size:.9rem;font-weight:500;transition:all .2s}.nav-links a:hover{background:var(--border);color:var(--text);text-decoration:none}.container{max-width:720px;margin:0 auto;padding:2rem}.footer{text-align:center;padding:2rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}.badge{display:inline-block;background:var(--surface);border:1px solid var(--border);color:var(--accent);padding:.25rem .75rem;border-radius:999px;font-size:.8rem;font-weight:600;margin-bottom:1rem}.post-card{display:block;padding:1.5rem;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:1rem;transition:border-color .2s;text-decoration:none;color:inherit}.post-card:hover{border-color:var(--accent);text-decoration:none}.post-card h3{font-size:1.25rem;margin-bottom:.25rem}.post-card .date{font-size:.85rem;color:var(--muted);margin-bottom:.5rem}.post-card .excerpt{color:var(--muted)}.post h1{font-size:2.25rem;margin-bottom:.5rem}.post .date{color:var(--muted);margin-bottom:2rem}.post p{font-size:1.1rem;line-height:1.8;margin-bottom:1rem}.back-link{display:inline-block;margin-bottom:1.5rem;color:var(--muted);font-size:.9rem}.back-link:hover{color:var(--accent)}.not-found{text-align:center;padding:4rem 2rem}.not-found h1{font-size:3rem;font-weight:800;color:var(--accent)}.loading{text-align:center;padding:4rem;color:var(--muted)}`}</style>
      </head>
      <body>
        <nav className="nav">
          <a href="/" className="nav-brand">PledgeBlog</a>
          <div className="nav-links">
            <a href="/">Home</a>
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
