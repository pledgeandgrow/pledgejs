export default function HomePage() {
  const endpoints = [
    { method: 'GET', path: '/api/items', desc: 'List all items' },
    { method: 'POST', path: '/api/items', desc: 'Create a new item' },
    { method: 'GET', path: '/api/items/:id', desc: 'Get a single item' },
    { method: 'PATCH', path: '/api/items/:id', desc: 'Update an item' },
    { method: 'DELETE', path: '/api/items/:id', desc: 'Delete an item' },
  ];

  return (
    <div className="container">
      <section style={{ paddingTop: '3rem' }}>
        <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>API Server</h1>
        <p style={{ color: 'var(--muted)', marginBottom: '2rem' }}>
          A REST API built with PledgeStack file-based routing. Each route handler exports HTTP methods as async functions.
        </p>

        <h2 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>Endpoints</h2>
        {endpoints.map((e) => (
          <div key={e.method + e.path} className="endpoint">
            <span className={`method ${e.method}`}>{e.method}</span>
            <span className="path">{e.path}</span>
            <span className="desc">{e.desc}</span>
          </div>
        ))}

        <h2 style={{ fontSize: '1.5rem', marginTop: '2rem', marginBottom: '1rem' }}>Try it</h2>
        <div className="code-block">
          <pre style={{ margin: 0 }}><span className="comment"># List all items</span>{'\n'}<span className="key">curl</span> http://localhost:3000/api/items{'\n\n'}<span className="comment"># Create an item</span>{'\n'}<span className="key">curl</span> -X POST http://localhost:3000/api/items{'\n'}  -H 'Content-Type: application/json'{'\n'}  -d '{`{"name":"Widget"}`}'</pre>
        </div>

        <h2 style={{ fontSize: '1.5rem', marginTop: '2rem', marginBottom: '1rem' }}>How it works</h2>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
          Create a file at <code style={{ color: 'var(--accent)' }}>app/api/items/route.ts</code> and export async functions named after HTTP methods:
        </p>
        <div className="code-block">
          <pre style={{ margin: 0 }}><span className="comment">// app/api/items/route.ts</span>{'\n'}<span className="key">export async function</span> GET() {'{'}{'\n'}  return Response.json(items);{'\n'}{'}'}{'\n\n'}<span className="key">export async function</span> POST(request: Request) {'{'}{'\n'}  const body = await request.json();{'\n'}{'}'}</pre>
        </div>
      </section>
    </div>
  );
}
