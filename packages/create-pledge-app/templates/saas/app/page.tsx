export default function HomePage() {
  return (
    <div>
      <section className="hero container">
        <h1>Launch your SaaS in <span className="gradient-text">days, not months</span></h1>
        <p>ShipFaster is a production-ready SaaS starter with authentication, payments, dashboards, and landing pages — all powered by PledgeStack's Rust-core rendering engine.</p>
        <div className="hero-actions">
          <a href="#pricing" className="btn btn-primary">Get Started Free</a>
          <a href="#features" className="btn btn-secondary">View Features</a>
        </div>
      </section>

      <section className="section" id="features">
        <div className="container">
          <h2>Everything you need to ship</h2>
          <p className="subtitle">From idea to production in one command</p>
          <div className="grid">
            <div className="card">
              <div className="icon">🔐</div>
              <h3>Authentication</h3>
              <p>Built-in auth with email, OAuth, and magic links. Session management and role-based access control out of the box.</p>
            </div>
            <div className="card">
              <div className="icon">💳</div>
              <h3>Payments</h3>
              <p>Stripe integration with subscriptions, one-time payments, and usage-based billing. Webhooks handled automatically.</p>
            </div>
            <div className="card">
              <div className="icon">📊</div>
              <h3>Dashboard</h3>
              <p>Beautiful admin dashboard with charts, data tables, and real-time updates. Dark mode included.</p>
            </div>
            <div className="card">
              <div className="icon">📧</div>
              <h3>Email</h3>
              <p>Transactional emails with React templates. Welcome flows, password resets, and notifications.</p>
            </div>
            <div className="card">
              <div className="icon">🚀</div>
              <h3>Deploy Anywhere</h3>
              <p>Deploy to Vercel, Railway, Fly.io, or your own VPS. Docker support with multi-stage builds.</p>
            </div>
            <div className="card">
              <div className="icon">🦀</div>
              <h3>Rust-Powered</h3>
              <p>PledgePack's Rust+Zig bundler delivers sub-millisecond transforms. No webpack, no babel, just speed.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="pricing" style={{ background: 'var(--surface)' }}>
        <div className="container">
          <h2>Simple, transparent pricing</h2>
          <p className="subtitle">Start free, scale as you grow</p>
          <div className="pricing">
            <div className="price-card">
              <h3>Starter</h3>
              <div className="price">$0<span>/mo</span></div>
              <ul>
                <li>Up to 100 users</li>
                <li>Community support</li>
                <li>Basic analytics</li>
                <li>1 project</li>
              </ul>
              <a href="/" className="btn btn-secondary">Get Started</a>
            </div>
            <div className="price-card featured">
              <div className="badge">Most Popular</div>
              <h3>Pro</h3>
              <div className="price">$29<span>/mo</span></div>
              <ul>
                <li>Up to 10,000 users</li>
                <li>Priority support</li>
                <li>Advanced analytics</li>
                <li>Unlimited projects</li>
                <li>Custom domains</li>
                <li>API access</li>
              </ul>
              <a href="/" className="btn btn-primary">Start Pro Trial</a>
            </div>
            <div className="price-card">
              <h3>Enterprise</h3>
              <div className="price">Custom</div>
              <ul>
                <li>Unlimited users</li>
                <li>Dedicated support</li>
                <li>SSO & SAML</li>
                <li>SLA guarantee</li>
                <li>On-premise option</li>
              </ul>
              <a href="/" className="btn btn-secondary">Contact Sales</a>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="testimonials">
        <div className="container">
          <h2>Loved by developers</h2>
          <p className="subtitle">Join thousands of builders shipping faster</p>
          <div className="testimonials">
            <div className="testimonial">
              <p>"We launched our SaaS in 3 days instead of 3 months. PledgeStack's Rust core makes everything blazing fast."</p>
              <div className="author">
                <div className="avatar">SK</div>
                <div>
                  <div className="name">Sarah Kim</div>
                  <div className="role">CTO, LinkFlow</div>
                </div>
              </div>
            </div>
            <div className="testimonial">
              <p>"The file-based routing and auto HTML shell are genius. No config, no boilerplate — just build."</p>
              <div className="author">
                <div className="avatar">JM</div>
                <div>
                  <div className="name">James Martinez</div>
                  <div className="role">Founder, DevPort</div>
                </div>
              </div>
            </div>
            <div className="testimonial">
              <p>"PledgePack's HMR is instant. Coming from Next.js, the speed difference is night and day."</p>
              <div className="author">
                <div className="avatar">AL</div>
                <div>
                  <div className="name">Anna Liu</div>
                  <div className="role">Lead Dev, CloudPeak</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="cta-section">
        <h2>Ready to ship?</h2>
        <p>Start building your SaaS today. No credit card required.</p>
        <a href="/" className="btn btn-primary" style={{ fontSize: '1.1rem', padding: '1rem 2.5rem' }}>Get Started Free →</a>
      </section>
    </div>
  );
}
