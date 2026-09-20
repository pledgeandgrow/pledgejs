import { describe, it, expect } from 'vitest';
import type { ResolvedRoute } from 'pledgestack-shared';
import { renderHeadTags } from './head-tags';

describe('renderHeadTags structured data', () => {
  it('cannot be broken out of via </script> in JSON-LD values', () => {
    const html = renderHeadTags(
      { structuredData: { '@type': 'Article', headline: '</script><script>alert(1)</script>' } } as never,
      { pattern: '/' } as ResolvedRoute,
    );
    expect(html).not.toContain('</script><script>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });
});
