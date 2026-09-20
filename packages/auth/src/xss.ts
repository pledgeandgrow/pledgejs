const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

export function sanitizeHtml(input: string): string {
  return input.replace(/[&<>"'`/=]/g, (char) => HTML_ENTITIES[char] ?? char);
}

export function sanitizeText(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

const DANGEROUS_PATTERNS = [
  /<script[\s\S]*?<\/script>/gi,
  /<iframe[\s\S]*?<\/iframe>/gi,
  /<object[\s\S]*?<\/object>/gi,
  /<embed[\s\S]*?<\/embed>/gi,
  /on\w+\s*=\s*"[^"]*"/gi,
  /on\w+\s*=\s*'[^']*'/gi,
  /on\w+\s*=\s*[^\s>]+/gi,
  /javascript:/gi,
  /vbscript:/gi,
  /data:text\/html/gi,
];

export function sanitizeInput(input: string): string {
  let result = input;
  // Removal can splice the surrounding text into a new dangerous token
  // (e.g. "jajavascript:vascript:"), so repeat until a fixed point.
  for (let pass = 0; pass < 20; pass++) {
    const before = result;
    for (const pattern of DANGEROUS_PATTERNS) {
      result = result.replace(pattern, '');
    }
    if (result === before) break;
  }
  return result;
}

export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeInput(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? sanitizeInput(v) : v));
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
