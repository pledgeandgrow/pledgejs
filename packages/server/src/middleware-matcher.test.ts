import { describe, it, expect } from 'vitest';
import { createMatcher } from './middleware-matcher';

describe('Middleware Matcher (#36)', () => {
  it('matches exact paths', () => {
    const match = createMatcher(['/about']);
    expect(match('/about')).toBe(true);
    expect(match('/home')).toBe(false);
  });

  it('matches wildcard paths', () => {
    const match = createMatcher(['/api/*']);
    expect(match('/api/users')).toBe(true);
    expect(match('/api/posts/123')).toBe(true);
    expect(match('/about')).toBe(false);
  });

  it('matches root path', () => {
    const match = createMatcher(['/']);
    expect(match('/')).toBe(true);
  });

  it('matches with multiple paths', () => {
    const match = createMatcher(['/about', '/contact']);
    expect(match('/about')).toBe(true);
    expect(match('/contact')).toBe(true);
    expect(match('/home')).toBe(false);
  });

  it('matches with param patterns', () => {
    const match = createMatcher(['/blog/:slug']);
    expect(match('/blog/hello')).toBe(true);
    expect(match('/blog/hello/world')).toBe(false);
  });

  it('matches with regex patterns', () => {
    const match = createMatcher([{ regex: '^/api/.*$' }]);
    expect(match('/api/users')).toBe(true);
    expect(match('/about')).toBe(false);
  });

  it('matches negative lookahead', () => {
    // Use anchored regex to properly exclude /api paths
    const match = createMatcher(['^(?!/api/).*$']);
    expect(match('/about')).toBe(true);
    expect(match('/api/users')).toBe(false);
  });
});
