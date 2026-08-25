import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

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

  const formData = await request.formData();
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

    let filename = file.name;
    if (uniqueNames) {
      // The extension is derived from the untrusted upload filename, so it can
      // contain slashes or `..` (e.g. "a.b/../../evil.png" → "b/../../evil.png").
      // Restrict it to a short alphanumeric token so the generated filename can
      // never escape uploadDir.
      const rawExt = file.name.includes('.') ? file.name.split('.').pop() ?? '' : '';
      const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      const hash = createHash('sha256').update(`${file.name}-${Date.now()}`).digest('hex').slice(0, 16);
      filename = ext ? `${hash}.${ext}` : hash;
    } else {
      // Sanitize filename to prevent path traversal
      filename = file.name.replace(/[/\\]/g, '_').replace(/\.\./g, '_');
    }

    const filepath = join(uploadDir, filename);
    await mkdir(dirname(filepath), { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
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
