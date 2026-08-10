import { describe, it, expect } from 'vitest';
import { generateDockerfile } from './docker';

describe('Dockerfile Generation (#49)', () => {
  it('generates a valid Dockerfile', async () => {
    const output = await generateDockerfile();
    expect(output).toContain('FROM');
    expect(output).toContain('node');
  });

  it('includes build step', async () => {
    const output = await generateDockerfile();
    expect(output.toLowerCase()).toContain('build');
  });

  it('includes CMD instruction', async () => {
    const output = await generateDockerfile();
    expect(output).toContain('CMD');
  });

  it('includes EXPOSE instruction', async () => {
    const output = await generateDockerfile();
    expect(output).toContain('EXPOSE');
  });

  it('supports custom port', async () => {
    const output = await generateDockerfile({ port: 8080 });
    expect(output).toContain('8080');
  });

  it('includes healthcheck when enabled', async () => {
    const output = await generateDockerfile({ healthcheck: true });
    expect(output).toContain('HEALTHCHECK');
  });
});
