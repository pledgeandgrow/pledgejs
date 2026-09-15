export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return (
    <div className="container">
      <div style={{ textAlign: 'center', padding: '4rem 2rem' }}>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 800, color: '#ef4444', marginBottom: '1rem' }}>
          Something went wrong
        </h1>
        <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>
          {error.message || 'An unexpected error occurred.'}
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '0.75rem 1.75rem',
            borderRadius: '10px',
            fontWeight: 600,
            background: 'var(--accent)',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Reload page
        </button>
      </div>
    </div>
  );
}
