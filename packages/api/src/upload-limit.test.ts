import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpload } from './upload';

describe('handleUpload body limit', () => {
  it('stops reading an oversized streamed body instead of buffering it all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pledge-upl-'));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 200) { controller.close(); return; }
        controller.enqueue(new Uint8Array(1024 * 1024)); // 1 MiB per chunk, 200 MiB total
      },
    });
    try {
      const req = new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=xyz' },
        body,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      await expect(handleUpload(req, { uploadDir: dir, maxSize: 1024, maxFiles: 1 })).rejects.toThrow(/too large/i);
      // cap = 1KiB + 256KiB overhead => a handful of 1MiB pulls at most
      expect(pulled).toBeLessThan(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects up-front on a declared Content-Length over the cap', async () => {
    const req = new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=xyz', 'content-length': String(10 * 1024 * 1024 * 1024) },
      body: 'x',
    });
    await expect(handleUpload(req, { maxSize: 1024, maxFiles: 1 })).rejects.toThrow(/too large/i);
  });

  it('still accepts a normal small upload', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pledge-upl-'));
    try {
      const fd = new FormData();
      fd.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
      const req = new Request('http://localhost/upload', { method: 'POST', body: fd });
      const res = await handleUpload(req, { uploadDir: dir, maxSize: 1024 });
      expect(res).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
