import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'ShopWave — Store',
  description: 'ShopWave — Modern E-commerce Store',
  themeColor: '#ec4899',
  openGraph: {
    title: 'ShopWave — Store',
    description: 'ShopWave — Modern E-commerce Store',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ec4899',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#fafafa;--surface:#fff;--surface2:#f3f4f6;--border:#e5e7eb;--text:#111827;--muted:#6b7280;--accent:#ec4899;--accent-dim:#db2777;--green:#16a34a;--radius:12px;--max-w:1200px}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}a{color:inherit;text-decoration:none}.nav{display:flex;align-items:center;gap:1rem;padding:1rem 2rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}.nav-brand{font-size:1.5rem;font-weight:800;color:var(--accent)}.nav-search{flex:1;max-width:400px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:.6rem 1rem;color:var(--muted);font-size:.9rem}.nav-links{display:flex;gap:.5rem;align-items:center}.nav-links a{color:var(--muted);padding:.5rem 1rem;border-radius:8px;font-size:.9rem;font-weight:500;transition:all .15s}.nav-links a:hover{background:var(--surface2);color:var(--text)}.nav-cart{position:relative;background:var(--accent);color:#fff;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:700;cursor:pointer;border:none}.nav-cart .count{position:absolute;top:-4px;right:-4px;background:var(--text);color:#fff;font-size:.65rem;font-weight:700;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center}.container{max-width:var(--max-w);margin:0 auto;padding:2rem}.hero-banner{background:linear-gradient(135deg,#ec4899 0%,#8b5cf6 100%);border-radius:20px;padding:3rem 2rem;text-align:center;color:#fff;margin-bottom:2.5rem}.hero-banner h1{font-size:2.5rem;font-weight:800;margin-bottom:.5rem}.hero-banner p{font-size:1.1rem;opacity:.9;margin-bottom:1.5rem}.hero-banner .btn{display:inline-block;background:#fff;color:var(--accent);padding:.8rem 2rem;border-radius:10px;font-weight:700;transition:all .2s}.hero-banner .btn:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,.15)}.section-title{font-size:1.5rem;font-weight:800;margin-bottom:1.5rem}.filters{display:flex;gap:.5rem;margin-bottom:2rem;flex-wrap:wrap}.filter{padding:.5rem 1.25rem;border-radius:8px;background:var(--surface);border:1px solid var(--border);font-size:.85rem;font-weight:600;color:var(--muted);cursor:pointer;transition:all .15s}.filter:hover{border-color:var(--accent);color:var(--accent)}.filter.active{background:var(--accent);color:#fff;border-color:var(--accent)}.products{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:1.5rem}.product{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:all .2s;cursor:pointer}.product:hover{border-color:var(--accent);transform:translateY(-4px);box-shadow:0 8px 24px rgba(0,0,0,.06)}.product .img{height:200px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:3rem}.product .body{padding:1rem}.product h3{font-size:.95rem;font-weight:700;margin-bottom:.25rem}.product .category{font-size:.75rem;color:var(--muted);margin-bottom:.5rem}.product .price{font-size:1.25rem;font-weight:800;color:var(--accent)}.product .old-price{font-size:.85rem;color:var(--muted);text-decoration:line-through;margin-left:.25rem}.product .rating{display:flex;align-items:center;gap:.25rem;margin:.5rem 0;font-size:.8rem;color:var(--muted)}.product .stars{color:#fbbf24}.product .add-btn{width:100%;background:var(--accent);color:#fff;border:none;padding:.6rem;border-radius:8px;font-weight:600;font-size:.85rem;cursor:pointer;transition:all .15s;margin-top:.5rem}.product .add-btn:hover{background:var(--accent-dim)}.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin:3rem 0;padding:2rem 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.feature{text-align:center}.feature .icon{font-size:2rem;margin-bottom:.5rem}.feature h4{font-size:.9rem;font-weight:700;margin-bottom:.25rem}.feature p{font-size:.8rem;color:var(--muted)}.footer{background:var(--surface);border-top:1px solid var(--border);padding:2rem;text-align:center;color:var(--muted);font-size:.85rem;margin-top:2rem}@media(max-width:640px){.nav-search{display:none}.hero-banner h1{font-size:1.75rem}}`}</style>
      </head>
      <body>
        <nav className="nav">
          <a href="/" className="nav-brand">ShopWave</a>
          <input className="nav-search" placeholder="Search products..." readOnly />
          <div className="nav-links">
            <a href="/">Home</a>
            <a href="/">Shop</a>
            <a href="/">About</a>
          </div>
          <button className="nav-cart">🛒<span className="count">3</span></button>
        </nav>
        {children}
        <footer className="footer">
          © 2025 ShopWave · Built with <a href="https://pledgestack.dev" style={{ color: 'var(--accent)' }}>PledgeStack</a> · Powered by PledgePack (Rust+Zig)
        </footer>
      </body>
    </html>
  );
}
