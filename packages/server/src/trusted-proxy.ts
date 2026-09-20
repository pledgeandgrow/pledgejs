/**
 * Trusted-proxy model for forwarded headers.
 *
 * Client-supplied X-Forwarded-For / X-Real-IP / X-Forwarded-Proto are only
 * meaningful when the direct peer is a reverse proxy that sets them. When
 * the peer isn't trusted, those headers are attacker-controlled: a client
 * hitting the origin directly could spoof a fresh XFF per request and
 * defeat IP-keyed rate limiting and brute-force lockouts.
 *
 * Default policy: trust forwarding headers only when the remote address is
 * private/loopback (same-host nginx, Docker bridge, VPC load balancer).
 * Public-facing proxies (Cloudflare, public LBs) require an explicit
 * config.trustedProxies entry.
 */

/** Loopback/private/link-local addresses — trusted to forward headers by default. */
export function isPrivateOrLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '::ffff:127.0.0.1') return true;
  if (normalized.startsWith('::ffff:')) return isPrivateOrLoopback(normalized.slice(7));
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80')) return true; // IPv6 ULA / link-local
  const parts = normalized.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 127 || // 127.0.0.0/8 loopback
    a === 10 || // 10.0.0.0/8
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    a === 0 // 0.0.0.0
  );
}

/** Parses an IPv4 address to a 32-bit number, or null if invalid/IPv6. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = parseInt(part, 10);
    if (Number.isNaN(n) || n < 0 || n > 255 || String(n) !== part) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/**
 * Checks whether a remote address matches the trustedProxies config.
 * Supports exact IPs (v4/v6) and IPv4 CIDR ranges.
 */
export function isTrustedProxyAddress(remoteAddress: string | undefined, trustedProxies: string[]): boolean {
  if (!remoteAddress) return false;
  const remote = remoteAddress.replace(/^\[|\]$/g, '').toLowerCase();
  // Dual-stack sockets report IPv4 peers as ::ffff:a.b.c.d — unwrap so IPv4
  // CIDR entries still match.
  const mappedRemote = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  for (const entry of trustedProxies) {
    const proxy = entry.trim().toLowerCase();
    if (!proxy) continue;
    if (proxy.includes('/')) {
      // CIDR — IPv4 only
      const [range, bitsRaw] = proxy.split('/');
      const bits = parseInt(bitsRaw ?? '', 10);
      const rangeInt = ipv4ToInt(range ?? '');
      const remoteInt = ipv4ToInt(mappedRemote);
      if (rangeInt === null || remoteInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((remoteInt & mask) === (rangeInt & mask)) return true;
    } else if (proxy === remote || proxy === `::ffff:${remote}` || remote === `::ffff:${proxy}`) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the direct peer may supply forwarding headers: either a
 * configured trusted proxy or, by default, a private/loopback peer.
 */
export function isRemoteTrusted(remoteAddress: string | undefined, trustedProxies?: string[]): boolean {
  if (trustedProxies && trustedProxies.length > 0) {
    return isTrustedProxyAddress(remoteAddress, trustedProxies);
  }
  return isPrivateOrLoopback(remoteAddress);
}

/**
 * Resolves the best-available client identifier for rate limiting / lockout.
 *
 * Forwarding headers are honored only from a trusted peer; otherwise the
 * socket address wins. When no socket address exists at all (edge runtimes,
 * where the platform itself sets X-Forwarded-For), the header is used
 * directly — there is no attacker-reachable way to bypass the platform's
 * own header handling.
 */
export function resolveClientIdentifier(
  headers: Record<string, string>,
  remoteAddress?: string,
  trustedProxies?: string[],
): string {
  // Right-to-left: the leftmost XFF entry is client-controlled (a proxy that
  // appends leaves any spoofed prefix intact), so take the first entry from
  // the right that is not itself a trusted proxy hop.
  const xffList = (headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let xff: string | undefined = xffList[0];
  for (let i = xffList.length - 1; i >= 0; i--) {
    if (!isRemoteTrusted(xffList[i], trustedProxies)) {
      xff = xffList[i];
      break;
    }
  }
  const realIp = headers['x-real-ip']?.trim();

  if (remoteAddress !== undefined) {
    if (isRemoteTrusted(remoteAddress, trustedProxies)) {
      if (xff) return xff;
      if (realIp) return realIp;
    }
    return remoteAddress;
  }

  // No socket info (edge runtime) — the platform owns these headers.
  if (xff) return xff;
  if (realIp) return realIp;
  return 'unknown';
}
