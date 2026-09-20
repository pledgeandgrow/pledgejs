import { describe, it, expect } from 'vitest';
import { renderHeadTags } from './head-tags';

describe('renderHeadTags JSON-LD', () => {
  it('escapes </script> breakout in structured data', () => {
    const html = renderHeadTags({
      title: 't',
      structuredData: { '@type': 'Thing', name: '</script><script>alert(1)</script>' },
    } as never);
    expect(html).not.toContain('</script><script>');
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1]!).name).toBe('</script><script>alert(1)</script>');
  });
});
