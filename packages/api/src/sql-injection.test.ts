import { describe, it, expect } from 'vitest';
import { detectSqlInjection, sanitizeSqlInput, validateParameterized } from './sql-injection';

describe('detectSqlInjection', () => {
  it('flags classic injection payloads', () => {
    expect(detectSqlInjection('1 OR 1=1')).toBe(true);
    expect(detectSqlInjection('1; DROP TABLE users;--')).toBe(true);
    expect(detectSqlInjection("admin'--")).toBe(true);
    expect(detectSqlInjection('UNION SELECT password FROM users')).toBe(true);
  });

  it('does not flag ordinary input', () => {
    expect(detectSqlInjection('alice@example.com')).toBe(false);
    expect(detectSqlInjection('Jane Doe')).toBe(false);
  });
});

describe('sanitizeSqlInput', () => {
  it('escapes quotes and strips null bytes/newlines', () => {
    expect(sanitizeSqlInput("O'Brien")).toBe("O''Brien");
    expect(sanitizeSqlInput('a\x00b')).toBe('ab');
    expect(sanitizeSqlInput('a\nb')).toBe('a b');
  });
});

describe('validateParameterized', () => {
  it('rejects template-literal interpolation without placeholders', () => {
    const r = validateParameterized('SELECT * FROM users WHERE id = ${id}');
    expect(r.safe).toBe(false);
  });

  it('accepts a parameterized query', () => {
    expect(validateParameterized('SELECT * FROM users WHERE id = ?').safe).toBe(true);
    expect(validateParameterized('SELECT * FROM users WHERE id = $1').safe).toBe(true);
  });
});
