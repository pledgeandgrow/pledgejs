import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from './audit';

describe('AuditLogger', () => {
  it('creates nested log directories for native (backslash on Windows) paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pledge-audit-'));
    try {
      const file = join(root, 'nested', 'deeper', 'audit.log');
      const logger = new AuditLogger({ filePath: file, console: false });
      await logger.logAuth('login', 'u1');
      const content = await readFile(file, 'utf8');
      expect(JSON.parse(content.trim()).action).toBe('auth:login');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AuditLogger rotation', () => {
  it('rotates once maxFileSize is exceeded and keeps at most maxFiles rotated files', async () => {
    const { readdir } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'pledge-audit-rot-'));
    try {
      const file = join(root, 'audit.log');
      const logger = new AuditLogger({ filePath: file, console: false, maxFileSize: 300, maxFiles: 2 });
      await Promise.all(Array.from({ length: 30 }, (_, i) => logger.logAuth('login', `user-${i}`)));
      const files = (await readdir(root)).sort();
      expect(files).toEqual(['audit.log', 'audit.log.1', 'audit.log.2']);
      const current = await readFile(file, 'utf8');
      expect(Buffer.byteLength(current)).toBeLessThanOrEqual(300);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
