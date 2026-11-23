import dns from 'dns';
import { BlockList, isIP } from 'net';
import { Agent, fetch } from 'undici';

/**
 * SSRF-safe HTTP for tenant-supplied URLs (webhooks).
 *
 *  - https only (http allowed only for local development, see allowPrivateTargets)
 *  - no credentials in the URL, no redirects followed
 *  - the target hostname is resolved by OUR lookup, every resolved address must be public, and
 *    the connection is made to that exact address, which defeats DNS rebinding
 *  - loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast,
 *    documentation and IPv4-mapped IPv6 ranges are blocked
 */
const blocked = new BlockList();
const V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6: Array<[string, number]> = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are refused outright: they are never a legitimate
 * webhook target, and Node's BlockList would otherwise match IPv4 addresses against IPv6 rules.
 * The URL parser normalises every spelling (dotted or hex, any zero compression) to `::ffff:`.
 */
function isIpv4Mapped(address: string): boolean {
  if (isIP(address) !== 6) return false;
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase().startsWith('::ffff:');
  } catch {
    return false;
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return false;
  if (isIpv4Mapped(address)) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** Local development/testing escape hatch. Ignored in production. */
export function allowPrivateTargets(): boolean {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true';
}

export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (url.username || url.password) throw new UnsafeUrlError('URLs with credentials are not allowed');
  const relaxed = allowPrivateTargets();
  if (url.protocol !== 'https:' && !(relaxed && url.protocol === 'http:')) {
    throw new UnsafeUrlError('Webhook URLs must use https');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!relaxed) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new UnsafeUrlError('Webhook URL host is not allowed');
    }
    if (isIP(host) && !isPublicAddress(host)) throw new UnsafeUrlError('Webhook URL points to a non-public address');
  }
  return url;
}

type LookupCallback = (err: Error | null, address?: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(new UnsafeUrlError(`No addresses for ${hostname}`));
    if (!allowPrivateTargets() && addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(new UnsafeUrlError(`Blocked non-public address for ${hostname}`));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

/** Validate a URL at registration time (syntax, scheme, and that DNS resolves to public addresses). */
export async function assertWebhookUrlAllowed(raw: string): Promise<void> {
  const url = parseWebhookUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  await new Promise<void>((resolve, reject) => {
    guardedLookup(host, { all: true }, (err) => (err ? reject(err instanceof UnsafeUrlError ? err : new UnsafeUrlError(`Cannot resolve ${host}`)) : resolve()));
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as never }, headersTimeout: 5000, bodyTimeout: 5000 });

export async function safePost(
  rawUrl: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 5000,
): Promise<{ ok: boolean; status: number }> {
  const url = parseWebhookUrl(rawUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    redirect: 'manual',
    dispatcher: agent,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await res.body?.cancel().catch(() => undefined);
  return { ok: res.status >= 200 && res.status < 300, status: res.status };
}
