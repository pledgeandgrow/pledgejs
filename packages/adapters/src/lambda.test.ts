import { describe, it, expect, vi } from 'vitest';

let lastRequest: Request | undefined;
vi.mock('pledgestack-server', () => ({
  createEdgeHandler: () => async (req: Request) => {
    lastRequest = req;
    const headers = new Headers();
    headers.append('Set-Cookie', 'a=1; Path=/');
    headers.append('Set-Cookie', 'b=2; Path=/');
    headers.set('Content-Type', 'text/plain');
    return new Response('ok', { status: 200, headers });
  },
}));

import { createLambdaHandler } from './lambda';

const config = {} as never;

describe('createLambdaHandler', () => {
  it('forwards HTTP API v2 request cookies (delivered in event.cookies, not headers)', async () => {
    const handler = createLambdaHandler({ config });
    await handler({
      version: '2.0',
      rawPath: '/',
      rawQueryString: '',
      headers: { host: 'x.example' },
      cookies: ['session=abc', 'theme=dark'],
      requestContext: { domainName: 'x.example', stage: '$default', http: { method: 'GET' } },
    } as never);
    expect(lastRequest?.headers.get('cookie')).toBe('session=abc; theme=dark');
  });

  it('returns every Set-Cookie for REST API (v1) events via multiValueHeaders', async () => {
    const handler = createLambdaHandler({ config });
    const res = await handler({
      httpMethod: 'GET',
      path: '/',
      headers: {},
      requestContext: { domainName: 'x.example', stage: 'prod' },
    } as never);
    expect((res as { multiValueHeaders?: Record<string, string[]> }).multiValueHeaders?.['Set-Cookie']).toEqual([
      'a=1; Path=/',
      'b=2; Path=/',
    ]);
  });

  it('keeps using the cookies array for v2 responses', async () => {
    const handler = createLambdaHandler({ config });
    const res = await handler({
      version: '2.0', rawPath: '/', rawQueryString: '', headers: {},
      requestContext: { domainName: 'x.example', stage: '$default', http: { method: 'GET' } },
    } as never);
    expect(res.cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });
});

import { createNetlifyHandler } from './netlify';
describe('protocol-relative paths must not change the request host', () => {
  it('lambda: rawPath "//evil.example/x" stays on the API host', async () => {
    const handler = createLambdaHandler({ config });
    await handler({
      version: '2.0', rawPath: '//evil.example/x', rawQueryString: '', headers: {},
      requestContext: { domainName: 'x.example', stage: '$default', http: { method: 'GET' } },
    } as never);
    expect(new URL(lastRequest!.url).host).toBe('x.example');
  });
  it('netlify: path "//evil.example/x" stays on the site host', async () => {
    const handler = createNetlifyHandler({ config });
    await handler({ httpMethod: 'GET', path: '//evil.example/x', headers: { host: 'site.example' } });
    expect(new URL(lastRequest!.url).host).toBe('site.example');
  });
});
