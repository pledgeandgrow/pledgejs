import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Common file magic bytes (signatures) for verifying that uploaded file
 * content matches its claimed MIME type. The browser's Content-Type header
 * is trivially spoofed, so we verify the actual file bytes server-side.
 */
const MAGIC_BYTES: Record<string, number[]> = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
};

/**
 * Verifies that file content matches the claimed MIME type.
 *
 * WebP is a RIFF container — `RIFF` alone also matches WAV and AVI, so the
 * four-byte "WEBP" form-type code at offset 8 must be checked too. Previously
 * only the generic RIFF header was verified, letting any RIFF file (e.g. a
 * .wav) pass as image/webp.
 *
 * SVG/text formats have no binary signature; for SVG we at least require the
 * content to look like XML/SVG markup so arbitrary binaries can't claim the
 * type.
 */
function matchesMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/webp') {
    // RIFF<4-byte size>WEBP
    return (
      buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    );
  }

  if (mimeType === 'image/svg+xml') {
    // No magic bytes — require XML-ish content with an <svg element so a
    // renamed binary can't claim to be an SVG.
    const head = buffer.subarray(0, 4096).toString('utf-8').trimStart();
    return head.startsWith('<') && /<svg[\s>]/i.test(head);
  }

  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    // No signature — but the content should at least be valid UTF-8 text,
    // not arbitrary binary. Reject NUL bytes (a strong binary indicator).
    return !buffer.includes(0x00);
  }

  const magic = MAGIC_BYTES[mimeType];
  if (!magic) return true; // Unknown type — nothing to verify against
  if (buffer.length < magic.length) return false;
  return magic.every((byte, i) => buffer[i] === byte);
}

export interface UploadOptions {
  /** Max file size in bytes (default: 10MB) */
  maxSize?: number;
  /** Allowed MIME types (default: all) */
  allowedTypes?: string[];
  /** Upload directory (default: 'public/uploads') */
  uploadDir?: string;
  /** Generate unique filename (default: true) */
  uniqueNames?: boolean;
  /** Max number of files (default: 10) */
  maxFiles?: number;
}

export interface UploadResult {
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  path: string;
}

/** Allowance for multipart boundaries, headers and non-file fields. */
const MULTIPART_OVERHEAD_BYTES = 256 * 1024;

/**
 * Parses multipart form data while counting bytes as they arrive, aborting
 * the read (and cancelling the upstream body) once `limit` is exceeded so an
 * oversized upload is never fully buffered.
 */
async function parseFormDataLimited(request: Request, limit: number): Promise<FormData> {
  if (!request.body) return request.formData();

  let received = 0;
  const reader = request.body.getReader();
  const limited = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel().catch(() => undefined);
        controller.error(new Error(`Upload too large: exceeds ${limit} bytes`));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const bounded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: limited,
    // Required by undici for stream request bodies.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  try {
    return await bounded.formData();
  } catch (err) {
    if (received > limit) throw new Error(`Upload too large: exceeds ${limit} bytes`);
    throw err;
  }
}

export async function handleUpload(
  request: Request,
  options: UploadOptions = {},
): Promise<UploadResult[]> {
  const {
    maxSize = 10 * 1024 * 1024,
    allowedTypes,
    uploadDir = 'public/uploads',
    uniqueNames = true,
    maxFiles = 10,
  } = options;

  // Bound the request body BEFORE parsing. request.formData() buffers the
  // entire body, so a 5GB upload would be fully read into memory before any
  // per-file size check ran. The cap covers all allowed files plus multipart
  // framing overhead; it is enforced on Content-Length up front and again
  // on the byte stream as it is consumed (Content-Length can lie/be absent).
  const totalCap = maxSize * maxFiles + MULTIPART_OVERHEAD_BYTES;
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > totalCap) {
    throw new Error(`Upload too large: exceeds ${totalCap} bytes`);
  }
  const formData = await parseFormDataLimited(request, totalCap);
  const files = formData.getAll('file').filter((v): v is File => v instanceof File);

  if (files.length === 0) {
    throw new Error('No files uploaded');
  }
  if (files.length > maxFiles) {
    throw new Error(`Too many files: max ${maxFiles}`);
  }

  await mkdir(uploadDir, { recursive: true });

  const results: UploadResult[] = [];

  for (const file of files) {
    if (file.size > maxSize) {
      throw new Error(`File ${file.name} exceeds max size of ${maxSize} bytes`);
    }

    if (allowedTypes && !allowedTypes.includes(file.type)) {
      throw new Error(`File type ${file.type} not allowed`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Verify the file's magic bytes match the claimed MIME type. The
    // browser-supplied Content-Type is trivially spoofed — an attacker can
    // upload a malicious file with a benign MIME type. This catches the
    // common image/PDF spoofing vectors.
    if (!matchesMagicBytes(buffer, file.type)) {
      throw new Error(`File ${file.name}: content does not match claimed type ${file.type}`);
    }

    let filename = file.name;
    if (uniqueNames) {
      // The extension is derived from the untrusted upload filename, so it can
      // contain slashes or `..` (e.g. "a.b/../../evil.png" → "b/../../evil.png").
      // Restrict it to a short alphanumeric token so the generated filename can
      // never escape uploadDir.
      const rawExt = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      // Random, not derived from name+timestamp: same-named files in one
      // request (same millisecond) used to collide and overwrite each other.
      const hash = randomBytes(12).toString('hex');
      filename = ext ? `${hash}.${ext}` : hash;
    } else {
      // Sanitize filename to prevent path traversal
      filename = file.name.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
    }

    const filepath = join(uploadDir, filename);
    await mkdir(dirname(filepath), { recursive: true });

    await writeFile(filepath, buffer);

    results.push({
      filename,
      originalName: file.name,
      size: file.size,
      mimeType: file.type,
      path: filepath,
    });
  }

  return results;
}
