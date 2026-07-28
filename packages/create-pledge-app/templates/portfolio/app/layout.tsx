import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="description" content="Alex Rivera — Full-Stack Developer & Designer" />
        <meta name="theme-color" content="#f59e0b" />
        <title>Alex Rivera — Portfolio</title>
        <style>{`*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0a0a0a;--surface:#141414;--surface2:#1e1e1e;--border:#2a2a2a;--text:#f5f5f5;--muted:#999;--accent:#f59e0b;--accent-dim:#d97706;--radius:16px;--max-w:900px}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.7}a{color:var(--accent);text-decoration:none;transition:all .2s}a:hover{color:var(--accent-dim);text-decoration:underline}.nav{display:flex;align-items:center;gap:1rem;padding:1.5rem 2rem;position:sticky;top:0;z-index:100;background:rgba(10,10,10,.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--border)}.nav-brand{font-size:1.1rem;font-weight:700;color:var(--text)}.nav-brand:hover{text-decoration:none;color:var(--accent)}.nav-links{display:flex;gap:.25rem;margin-left:auto}.nav-links a{color:var(--muted);padding:.5rem 1rem;border-radius:8px;font-size:.9rem;font-weight:500}.nav-links a:hover{background:var(--surface2);color:var(--text);text-decoration:none}.container{max-width:var(--max-w);margin:0 auto;padding:0 2rem}.hero{padding:6rem 0 4rem;text-align:center}.hero .avatar{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#ef4444);margin:0 auto 1.5rem;display:flex;align-items:center;justify-content:center;font-size:3rem;font-weight:800;color:#fff}.hero h1{font-size:2.5rem;font-weight:800;margin-bottom:.5rem}.hero .tagline{font-size:1.2rem;color:var(--muted);margin-bottom:2rem}.hero .socials{display:flex;gap:1rem;justify-content:center}.hero .socials a{width:40px;height:40px;border-radius:50%;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:1rem;color:var(--muted)}.hero .socials a:hover{background:var(--accent);color:#fff;border-color:var(--accent);text-decoration:none}.section{padding:4rem 0;border-top:1px solid var(--border)}.section h2{font-size:1.75rem;font-weight:800;margin-bottom:2rem}.section h2 .num{color:var(--accent);font-size:.9rem;font-weight:600;margin-right:.5rem}.projects{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1.5rem}.project{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:all .3s}.project:hover{border-color:var(--accent);transform:translateY(-4px)}.project .thumb{height:160px;background:linear-gradient(135deg,var(--surface2),var(--border));display:flex;align-items:center;justify-content:center;font-size:2.5rem}.project .body{padding:1.5rem}.project h3{font-size:1.1rem;font-weight:700;margin-bottom:.5rem}.project p{color:var(--muted);font-size:.9rem;margin-bottom:1rem}.project .tags{display:flex;flex-wrap:wrap;gap:.5rem}.project .tag{background:var(--surface2);color:var(--muted);padding:.25rem .6rem;border-radius:6px;font-size:.75rem;font-weight:500}.project .links{display:flex;gap:1rem;margin-top:1rem}.project .links a{font-size:.85rem;font-weight:600}.about{display:grid;grid-template-columns:1fr 1fr;gap:3rem;align-items:start}.about p{color:var(--muted);margin-bottom:1rem}.skills{display:flex;flex-wrap:wrap;gap:.5rem}.skill{background:var(--surface);border:1px solid var(--border);padding:.5rem 1rem;border-radius:8px;font-size:.85rem;font-weight:500}.skill .level{color:var(--accent);font-size:.75rem;margin-left:.25rem}.contact{text-align:center;padding:4rem 0}.contact h2{font-size:2rem;font-weight:800;margin-bottom:1rem}.contact p{color:var(--muted);margin-bottom:2rem}.contact .btn{display:inline-block;padding:1rem 2.5rem;background:var(--accent);color:#0a0a0a;border-radius:12px;font-weight:700;font-size:1rem;transition:all .2s}.contact .btn:hover{background:var(--accent-dim);text-decoration:none;transform:translateY(-2px)}.footer{text-align:center;padding:2rem;border-top:1px solid var(--border);color:var(--muted);font-size:.85rem}@media(max-width:640px){.about{grid-template-columns:1fr}.hero h1{font-size:2rem}}`}</style>
      </head>
      <body>
        <nav className="nav">
          <a href="/" className="nav-brand">Alex Rivera</a>
          <div className="nav-links">
            <a href="/#projects">Projects</a>
            <a href="/#about">About</a>
            <a href="/#contact">Contact</a>
          </div>
        </nav>
        {children}
        <footer className="footer">
          © 2025 Alex Rivera · Built with <a href="https://pledgestack.dev">PledgeStack</a>
        </footer>
      </body>
    </html>
  );
}
