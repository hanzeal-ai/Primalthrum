import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface ProviderResolvedAddress {
  address: string;
  family: number;
}

export type ProviderAddressResolver = (
  hostname: string,
) => Promise<readonly ProviderResolvedAddress[]>;

const FORBIDDEN_HOSTNAMES = new Set([
  'instance-data',
  'metadata',
  'metadata.google.internal',
  'metadata.google.internal.',
]);

const FORBIDDEN_SUFFIXES = [
  '.home.arpa',
  '.internal',
  '.local',
  '.localhost',
] as const;

const FORBIDDEN_IPV4_ADDRESSES = createForbiddenIpv4List();
const FORBIDDEN_IPV6_ADDRESSES = createForbiddenIpv6List();

export function normalizeProviderBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('provider baseUrl must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('provider baseUrl must use HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('provider baseUrl cannot include credentials');
  }
  if (url.search || url.hash) {
    throw new Error('provider baseUrl cannot include a query or fragment');
  }
  const hostname = normalizedHostname(url.hostname);
  assertAllowedHostname(hostname);
  const literalAddress = ipLiteral(hostname);
  if (literalAddress && isForbiddenProviderAddress(literalAddress)) {
    throw new Error('provider baseUrl cannot target a private or reserved address');
  }
  url.hostname = hostname;
  return url.toString().replace(/\/$/, '');
}

export async function assertProviderEndpointSafe(
  value: string,
  resolveAddresses: ProviderAddressResolver = defaultResolver,
): Promise<string> {
  const normalized = normalizeProviderBaseUrl(value);
  const hostname = normalizedHostname(new URL(normalized).hostname);
  if (ipLiteral(hostname)) return normalized;

  let addresses: readonly ProviderResolvedAddress[];
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    throw new Error('provider baseUrl hostname could not be resolved safely');
  }
  if (!addresses.length) {
    throw new Error('provider baseUrl hostname did not resolve');
  }
  if (addresses.some((entry) => (
    !isIP(entry.address) || isForbiddenProviderAddress(entry.address)
  ))) {
    throw new Error('provider baseUrl resolved to a private or reserved address');
  }
  return normalized;
}

export function isForbiddenProviderAddress(value: string): boolean {
  const address = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(address);
  if (!family) return true;
  if (family === 4) return FORBIDDEN_IPV4_ADDRESSES.check(address, 'ipv4');
  if (address.startsWith('::ffff:')) return true;
  return FORBIDDEN_IPV6_ADDRESSES.check(address, 'ipv6');
}

async function defaultResolver(hostname: string): Promise<readonly ProviderResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function normalizedHostname(value: string): string {
  const hostname = value.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new Error('provider baseUrl hostname is required');
  return hostname;
}

function assertAllowedHostname(hostname: string): void {
  if (
    hostname === 'localhost'
    || FORBIDDEN_HOSTNAMES.has(hostname)
    || FORBIDDEN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('provider baseUrl cannot target a private or metadata hostname');
  }
}

function ipLiteral(hostname: string): string | null {
  return isIP(hostname) ? hostname : null;
}

function createForbiddenIpv4List(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv4');
  }
  return list;
}

function createForbiddenIpv6List(): BlockList {
  const list = new BlockList();
  for (const [address, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['100::', 64],
    ['2001:db8::', 32],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
}
