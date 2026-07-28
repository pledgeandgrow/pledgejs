import type { ReactNode } from 'react';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="description" content="Admin Dashboard — PledgeStack" />
        <meta name="theme-color" content="#0ea5e9" />
        <title>Admin Dashboard</title>
        <style>{`*{margin:0;padding:0;box-sizing:border-box}:root{--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--border:#475569;--text:#f1f5f9;--muted:#94a3b8;--accent:#0ea5e9;--accent-dim:#0284c7;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--radius:12px;--sidebar:240px}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;line-height:1.6}a{color:inherit;text-decoration:none}.layout{display:flex;min-height:100vh}.sidebar{width:var(--sidebar);background:var(--surface);border-right:1px solid var(--border);padding:1.5rem 0;position:fixed;top:0;bottom:0;overflow-y:auto;z-index:50}.sidebar-brand{font-size:1.25rem;font-weight:800;padding:0 1.5rem 1.5rem;color:var(--accent);border-bottom:1px solid var(--border);margin-bottom:1rem}.sidebar-nav{display:flex;flex-direction:column;gap:.25rem;padding:0 .75rem}.sidebar-nav a{display:flex;align-items:center;gap:.75rem;padding:.7rem 1rem;border-radius:8px;color:var(--muted);font-size:.9rem;font-weight:500;transition:all .15s}.sidebar-nav a:hover{background:var(--surface2);color:var(--text)}.sidebar-nav a.active{background:var(--accent);color:#fff}.sidebar-nav .icon{font-size:1.1rem;width:20px;text-align:center}.main{flex:1;margin-left:var(--sidebar);display:flex;flex-direction:column}.topbar{display:flex;align-items:center;gap:1rem;padding:1rem 2rem;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:40}.topbar h1{font-size:1.25rem;font-weight:700}.topbar .search{margin-left:auto;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:.5rem 1rem;color:var(--muted);font-size:.85rem;width:240px}.topbar .avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;color:#fff}.content{padding:2rem;flex:1}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1.5rem;margin-bottom:2rem}.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem}.stat-card .label{color:var(--muted);font-size:.8rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.5rem}.stat-card .value{font-size:2rem;font-weight:800;margin-bottom:.5rem}.stat-card .change{font-size:.85rem;font-weight:600}.stat-card .change.up{color:var(--green)}.stat-card .change.down{color:var(--red)}.chart-container{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.5rem;margin-bottom:2rem}.chart-container h3{font-size:1rem;font-weight:700;margin-bottom:1.5rem}.chart{display:flex;align-items:flex-end;gap:.75rem;height:200px;padding-bottom:2rem;border-bottom:1px solid var(--border)}.chart .bar{flex:1;background:linear-gradient(180deg,var(--accent),var(--accent-dim));border-radius:6px 6px 0 0;position:relative;min-height:4px;transition:all .3s}.chart .bar:hover{opacity:.8}.chart .bar .label{position:absolute;bottom:-1.5rem;left:50%;transform:translateX(-50%);font-size:.7rem;color:var(--muted);white-space:nowrap}.table-container{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}.table-container h3{font-size:1rem;font-weight:700;padding:1.5rem 1.5rem 1rem}.table{width:100%;border-collapse:collapse}.table th{text-align:left;padding:.75rem 1.5rem;font-size:.75rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);border-bottom:1px solid var(--border)}.table td{padding:.75rem 1.5rem;font-size:.9rem;border-bottom:1px solid var(--border)}.table tr:last-child td{border-bottom:none}.table tr:hover{background:var(--surface2)}.badge{display:inline-block;padding:.2rem .6rem;border-radius:6px;font-size:.75rem;font-weight:600}.badge.green{background:rgba(34,197,94,.15);color:var(--green)}.badge.yellow{background:rgba(234,179,8,.15);color:var(--yellow)}.badge.red{background:rgba(239,68,68,.15);color:var(--red)}.badge.blue{background:rgba(14,165,233,.15);color:var(--accent)}@media(max-width:768px){.sidebar{display:none}.main{margin-left:0}}`}</style>
      </head>
      <body>
        <div className="layout">
          <aside className="sidebar">
            <div className="sidebar-brand">Dashboard</div>
            <nav className="sidebar-nav">
              <a href="/" className="active"><span className="icon">📊</span> Overview</a>
              <a href="/"><span className="icon">📈</span> Analytics</a>
              <a href="/"><span className="icon">👥</span> Users</a>
              <a href="/"><span className="icon">📦</span> Orders</a>
              <a href="/"><span className="icon">💳</span> Payments</a>
              <a href="/"><span className="icon">⚙️</span> Settings</a>
            </nav>
          </aside>
          <div className="main">
            <div className="topbar">
              <h1>Overview</h1>
              <input className="search" placeholder="Search..." readOnly />
              <div className="avatar">AD</div>
            </div>
            <div className="content">
              {children}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
