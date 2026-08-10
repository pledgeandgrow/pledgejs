import { describe, it, expect } from 'vitest';
import { mdxPlugin, type MDXPageProps } from 'pledgestack-mdx';

describe('MDX Plugin (#17)', () => {
  it('creates an MDX plugin', () => {
    const plugin = mdxPlugin();
    expect(plugin).toBeDefined();
    expect(plugin.name).toBeDefined();
  });

  it('accepts custom options', () => {
    const plugin = mdxPlugin({ extensions: ['.mdx', '.md'] });
    expect(plugin).toBeDefined();
  });

  it('MDXPageProps is a valid interface', () => {
    const props: MDXPageProps = { children: 'test' };
    expect(props).toBeDefined();
  });
});
