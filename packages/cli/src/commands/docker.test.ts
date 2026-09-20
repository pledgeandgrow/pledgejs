import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateDockerfile } from './docker';

// Always write into a temp dir — the generator writes to disk, and the default
// (cwd) would overwrite the repository's own Dockerfile on every test run.
const out = join(mkdtempSync(join(tmpdir(), 'pledge-docker-')), 'Dockerfile');

describe('Dockerfile Generation (#49)', () => {
  it('generates a valid Dockerfile', async () => {
    const output = await generateDockerfile({ output: out });
    expect(output).toContain('FROM');
    expect(output).toContain('node');
  });

  it('includes build step', async () => {
    const output = await generateDockerfile({ output: out });
    expect(output.toLowerCase()).toContain('build');
  });

  it('includes CMD instruction', async () => {
    const output = await generateDockerfile({ output: out });
    expect(output).toContain('CMD');
  });

  it('includes EXPOSE instruction', async () => {
    const output = await generateDockerfile({ output: out });
    expect(output).toContain('EXPOSE');
  });

  it('supports custom port', async () => {
    const output = await generateDockerfile({ port: 8080, output: out });
    expect(output).toContain('8080');
  });

  it('includes healthcheck when enabled', async () => {
    const output = await generateDockerfile({ healthcheck: true, output: out });
    expect(output).toContain('HEALTHCHECK');
  });
});

describe('Dockerfile runtime command', () => {
  it('starts the server on the exposed port and on all interfaces', async () => {
    const output = await generateDockerfile({ port: 8080, output: out });
    expect(output).toContain('EXPOSE 8080');
    expect(output).toContain('--port 8080');
    expect(output).toContain('--hostname 0.0.0.0');
  });

  it('keeps a custom start command JSON-safe', async () => {
    const output = await generateDockerfile({ startCommand: 'node "server.js" --flag', output: out });
    expect(output).toContain('CMD ["sh", "-c", "node \\"server.js\\" --flag"]');
  });

  it('does not require a public/ directory in the build stage', async () => {
    const output = await generateDockerfile({ output: out });
    expect(output).not.toContain('/app/public');
  });
});
