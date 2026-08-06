import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProviderEndpointSafe,
  isForbiddenProviderAddress,
  normalizeProviderBaseUrl,
} from '../src/services/providerEndpointPolicy';

test('provider endpoint normalization rejects credential, metadata, and non-HTTPS targets', () => {
  assert.equal(
    normalizeProviderBaseUrl('https://API.EXAMPLE.com/v1/'),
    'https://api.example.com/v1',
  );
  for (const target of [
    'http://api.example.com/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?target=metadata',
    'https://api.example.com/v1#fragment',
    'https://localhost/v1',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://service.internal/v1',
    'https://127.0.0.1/v1',
    'https://2130706433/v1',
    'https://10.0.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/v1',
    'https://[fc00::1]/v1',
  ]) {
    assert.throws(() => normalizeProviderBaseUrl(target), /provider baseUrl/, target);
  }
  assert.equal(isForbiddenProviderAddress('8.8.8.8'), false);
  assert.equal(isForbiddenProviderAddress('192.168.1.1'), true);
});

test('provider endpoint DNS validation rejects private or mixed resolution', async () => {
  const safe = await assertProviderEndpointSafe('https://provider.example/v1', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  assert.equal(safe, 'https://provider.example/v1');

  await assert.rejects(
    assertProviderEndpointSafe('https://provider.example/v1', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.8', family: 4 },
    ]),
    /private or reserved/,
  );
  await assert.rejects(
    assertProviderEndpointSafe('https://provider.example/v1', async () => []),
    /did not resolve/,
  );
  await assert.rejects(
    assertProviderEndpointSafe('https://provider.example/v1', async () => {
      throw new Error('DNS unavailable');
    }),
    /could not be resolved safely/,
  );
});
