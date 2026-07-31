export function normalizeProviderBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('provider baseUrl must be a valid URL');
  }
  if (url.username || url.password) {
    throw new Error('provider baseUrl cannot include credentials');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('provider baseUrl must use HTTPS or loopback HTTP');
  }
  return url.toString().replace(/\/$/, '');
}
