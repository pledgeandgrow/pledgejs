export default function NotFoundPage() {
  return (
    <div className="container">
      <div className="not-found">
        <h1>404</h1>
        <p>This page could not be found.</p>
        <a href="/" style={{ color: 'var(--accent)' }}>← Go Home</a>
      </div>
    </div>
  );
}
