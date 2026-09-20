export interface ValidationSchema {
  body?: Record<string, { type: 'string' | 'number' | 'boolean' | 'array' | 'object'; required?: boolean; min?: number; max?: number; pattern?: string }>;
  query?: Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean }>;
  params?: Record<string, { type: 'string' | 'number'; required?: boolean }>;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

export function validateRequest(
  data: Record<string, unknown>,
  schema: Record<string, { type: string; required?: boolean; min?: number; max?: number; pattern?: string }>,
): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];

  for (const [field, rules] of Object.entries(schema)) {
    const value = data[field];

    if (rules.required && (value === undefined || value === null)) {
      errors.push({ field, message: `${field} is required` });
      continue;
    }

    if (value === undefined || value === null) continue;

    if (rules.type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ field, message: `${field} must be a string` });
        continue;
      }
      if (rules.min !== undefined && value.length < rules.min) {
        errors.push({ field, message: `${field} must be at least ${rules.min} characters` });
      }
      if (rules.max !== undefined && value.length > rules.max) {
        errors.push({ field, message: `${field} must be at most ${rules.max} characters` });
      }
      if (rules.pattern) {
        try {
          if (!new RegExp(rules.pattern).test(value)) {
            errors.push({ field, message: `${field} does not match required pattern` });
          }
        } catch {
          errors.push({ field, message: `${field} has an invalid validation pattern` });
        }
      }
    } else if (rules.type === 'number') {
      // Number('') === 0 and Number(true) === 1, which would let blank or
      // boolean input through as valid numbers — only real numbers and
      // non-blank numeric strings qualify.
      const isNumeric =
        (typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && value.trim() !== '');
      const num = isNumeric ? Number(value) : NaN;
      if (isNaN(num)) {
        errors.push({ field, message: `${field} must be a number` });
        continue;
      }
      if (rules.min !== undefined && num < rules.min) {
        errors.push({ field, message: `${field} must be at least ${rules.min}` });
      }
      if (rules.max !== undefined && num > rules.max) {
        errors.push({ field, message: `${field} must be at most ${rules.max}` });
      }
    } else if (rules.type === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push({ field, message: `${field} must be a boolean` });
      }
    } else if (rules.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push({ field, message: `${field} must be an array` });
      }
    } else if (rules.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ field, message: `${field} must be an object` });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
