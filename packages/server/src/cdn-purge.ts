import type { CdnConfig } from 'pledgestack-shared';

/** Purge options — same shape as PledgeConfig['cdn'], minus `paths` (passed separately as `urls`). */
export type CdnPurgeOptions = Omit<CdnConfig, 'paths'>;

export async function purgeCache(
  urls: string[],
  options: CdnPurgeOptions,
): Promise<{ success: boolean; purged: number; errors?: string[] }> {
  const { provider, token } = options;
  const errors: string[] = [];

  try {
    switch (provider) {
      case 'cloudflare':
        return await purgeCloudflare(urls, options);
      case 'fastly':
        return await purgeFastly(urls, options);
      case 'vercel':
        return await purgeVercel(urls, token);
      case 'netlify':
        return await purgeNetlify(urls, token);
      default:
        return { success: false, purged: 0, errors: [`Unknown provider: ${provider}`] };
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { success: false, purged: 0, errors };
  }
}

async function purgeCloudflare(urls: string[], options: CdnPurgeOptions): Promise<{ success: boolean; purged: number }> {
  const { token, zoneId } = options;
  if (!zoneId) throw new Error('Cloudflare requires zoneId');

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: urls }),
  });

  return { success: res.ok, purged: res.ok ? urls.length : 0 };
}

async function purgeFastly(urls: string[], options: CdnPurgeOptions): Promise<{ success: boolean; purged: number }> {
  const { token, zoneId: serviceId } = options;
  if (!serviceId) throw new Error('Fastly requires serviceId (zoneId)');

  const res = await fetch(`https://api.fastly.com/service/${serviceId}/purge`, {
    method: 'POST',
    headers: {
      'Fastly-Key': token,
      'Accept': 'application/json',
    },
    body: JSON.stringify({ surrogates: urls }),
  });

  return { success: res.ok, purged: res.ok ? urls.length : 0 };
}

async function purgeVercel(urls: string[], token: string): Promise<{ success: boolean; purged: number }> {
  for (const url of urls) {
    await fetch(`https://api.vercel.com/v2/deploys?url=${encodeURIComponent(url)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  }
  return { success: true, purged: urls.length };
}

async function purgeNetlify(urls: string[], token: string): Promise<{ success: boolean; purged: number }> {
  const res = await fetch('https://api.netlify.com/api/v1/purge', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ paths: urls }),
  });

  return { success: res.ok, purged: res.ok ? urls.length : 0 };
}
