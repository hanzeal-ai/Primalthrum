import { isIP } from 'node:net';

export function resolveClientAddress(input: {
  remoteAddress?: string;
  forwardedFor?: string;
  trustedProxyHops: number;
}): string {
  const remote = normalizeAddress(input.remoteAddress) ?? 'unknown';
  if (input.trustedProxyHops === 0 || !input.forwardedFor) return remote;
  const forwarded = input.forwardedFor.split(',').map((value) => normalizeAddress(value.trim()));
  if (forwarded.some((value) => value === null)) return remote;
  const chain = [...forwarded as string[], remote];
  const clientIndex = chain.length - input.trustedProxyHops - 1;
  return clientIndex >= 0 ? chain[clientIndex]! : remote;
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
  return isIP(normalized) ? normalized : null;
}
