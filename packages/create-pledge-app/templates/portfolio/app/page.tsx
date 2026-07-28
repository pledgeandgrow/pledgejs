export default function HomePage() {
  return (
    <div>
      <section className="hero container">
        <div className="avatar">AR</div>
        <h1>Alex Rivera</h1>
        <p className="tagline">Full-Stack Developer & Designer — building fast, beautiful web apps with Rust-powered tools.</p>
        <div className="socials">
          <a href="https://github.com/" title="GitHub">GH</a>
          <a href="https://twitter.com/" title="Twitter">TW</a>
          <a href="https://linkedin.com/" title="LinkedIn">LI</a>
          <a href="mailto:alex@example.com" title="Email">@</a>
        </div>
      </section>

      <section className="section container" id="projects">
        <h2><span className="num">01.</span> Featured Projects</h2>
        <div className="projects">
          <div className="project">
            <div className="thumb">🚀</div>
            <div className="body">
              <h3>ShipFaster</h3>
              <p>A SaaS starter kit with auth, payments, and dashboards. Built with PledgeStack and PledgePack.</p>
              <div className="tags">
                <span className="tag">PledgeStack</span>
                <span className="tag">Rust</span>
                <span className="tag">Stripe</span>
              </div>
              <div className="links">
                <a href="/">Live Demo →</a>
                <a href="/">Source →</a>
              </div>
            </div>
          </div>
          <div className="project">
            <div className="thumb">📊</div>
            <div className="body">
              <h3>DataFlow</h3>
              <p>Real-time analytics dashboard with WebSocket updates and chart visualizations.</p>
              <div className="tags">
                <span className="tag">React</span>
                <span className="tag">WebSocket</span>
                <span className="tag">D3</span>
              </div>
              <div className="links">
                <a href="/">Live Demo →</a>
                <a href="/">Source →</a>
              </div>
            </div>
          </div>
          <div className="project">
            <div className="thumb">🎨</div>
            <div className="body">
              <h3>DesignKit</h3>
              <p>An open-source component library with 50+ accessible React components and dark mode.</p>
              <div className="tags">
                <span className="tag">React</span>
                <span className="tag">TypeScript</span>
                <span className="tag">a11y</span>
              </div>
              <div className="links">
                <a href="/">Live Demo →</a>
                <a href="/">Source →</a>
              </div>
            </div>
          </div>
          <div className="project">
            <div className="thumb">🦀</div>
            <div className="body">
              <h3>RustAPI</h3>
              <p>A high-performance REST API framework for Rust with async support and OpenAPI docs.</p>
              <div className="tags">
                <span className="tag">Rust</span>
                <span className="tag">Axum</span>
                <span className="tag">Tokio</span>
              </div>
              <div className="links">
                <a href="/">Docs →</a>
                <a href="/">Source →</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section container" id="about">
        <h2><span className="num">02.</span> About Me</h2>
        <div className="about">
          <div>
            <p>I'm a full-stack developer with 8+ years of experience building web applications. I specialize in React, Rust, and performance optimization.</p>
            <p>Currently focused on PledgeStack — a Rust-powered React framework that combines the developer experience of Next.js with the speed of native code.</p>
            <p>When I'm not coding, you'll find me hiking, contributing to open source, or experimenting with new web technologies.</p>
          </div>
          <div>
            <h3 style={{ fontSize: '1rem', marginBottom: '1rem', color: 'var(--muted)' }}>Skills & Tools</h3>
            <div className="skills">
              <span className="skill">Rust <span className="level">Expert</span></span>
              <span className="skill">React <span className="level">Expert</span></span>
              <span className="skill">TypeScript <span className="level">Expert</span></span>
              <span className="skill">Node.js <span className="level">Advanced</span></span>
              <span className="skill">PostgreSQL <span className="level">Advanced</span></span>
              <span className="skill">Docker <span className="level">Advanced</span></span>
              <span className="skill">AWS <span className="level">Intermediate</span></span>
              <span className="skill">Figma <span className="level">Intermediate</span></span>
            </div>
          </div>
        </div>
      </section>

      <section className="contact container" id="contact">
        <h2>Let's build something together</h2>
        <p>I'm available for freelance work and collaborations. Drop me a line!</p>
        <a href="mailto:alex@example.com" className="btn">Get in touch →</a>
      </section>
    </div>
  );
}
