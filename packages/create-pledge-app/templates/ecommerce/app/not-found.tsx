export default function NotFoundPage() {
  return (
    <div className="container" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
      <h1 style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--accent)' }}>404</h1>
      <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>This page could not be found.</p>
      <a href="/" style={{ color: 'var(--accent)' }}>← Go Home</a>
    </div>
  );
}
