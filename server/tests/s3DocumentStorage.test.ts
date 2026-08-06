import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDocumentFileStorage } from '../src/services/documentStorageConfiguration';
import { LocalDocumentStorage } from '../src/services/fileStorage';
import { S3DocumentStorage } from '../src/services/s3DocumentStorage';

const FIXED_TIME = new Date('2026-08-06T12:34:56.000Z');

test('S3 storage signs scoped PUT, GET, DELETE, and bucket health requests', async () => {
  const requests: Array<{ headers: Headers; method: string; url: URL; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const method = init?.method ?? 'GET';
    requests.push({
      headers: new Headers(init?.headers),
      method,
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return new Response(method === 'GET' ? 'stored document' : '', { status: 200 });
  };
  const storage = new S3DocumentStorage({
    accessKeyId: 'test-access-key',
    bucket: 'primalthrum-documents',
    endpoint: 'https://objects.example.test/storage',
    fetchImpl,
    now: () => FIXED_TIME,
    prefix: 'production/customer-files',
    region: 'us-east-1',
    secretAccessKey: 'test-secret-key',
  });

  const saved = await storage.save({
    workspaceId: 7,
    agentId: 8,
    documentId: 9,
    filename: 'Guide final.txt',
    content: 'stored document',
  });
  assert.equal(
    saved.storageRef,
    's3://primalthrum-documents/production/customer-files/workspaces/7/agents/8/documents/9/Guide_final.txt',
  );
  assert.equal(saved.absolutePath, undefined);
  assert.equal(await storage.read(saved.storageRef), 'stored document');
  await storage.delete(saved.storageRef);
  await storage.healthCheck();

  assert.deepEqual(requests.map((request) => request.method), ['PUT', 'GET', 'DELETE', 'HEAD']);
  assert.equal(
    requests[0]?.url.pathname,
    '/storage/primalthrum-documents/production/customer-files/workspaces/7/agents/8/documents/9/Guide_final.txt',
  );
  assert.equal(requests[0]?.body, 'stored document');
  assert.equal(requests[3]?.url.pathname, '/storage/primalthrum-documents');
  for (const request of requests) {
    assert.equal(request.headers.get('x-amz-date'), '20260806T123456Z');
    assert.match(request.headers.get('x-amz-content-sha256') ?? '', /^[a-f0-9]{64}$/);
    assert.match(
      request.headers.get('authorization') ?? '',
      /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260806\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
    );
    assert.equal((request.headers.get('authorization') ?? '').includes('test-secret-key'), false);
  }
});

test('S3 storage rejects cross-bucket and cross-prefix refs before transport', async () => {
  let requests = 0;
  const storage = new S3DocumentStorage({
    accessKeyId: 'test-access-key',
    bucket: 'primalthrum-documents',
    endpoint: 'https://objects.example.test',
    fetchImpl: async () => {
      requests += 1;
      return new Response('', { status: 200 });
    },
    prefix: 'tenant-data',
    region: 'us-east-1',
    secretAccessKey: 'test-secret-key',
  });

  await assert.rejects(
    storage.read('s3://other-bucket/tenant-data/workspaces/1/document.txt'),
    /outside the configured bucket/,
  );
  await assert.rejects(
    storage.delete('s3://primalthrum-documents/other-prefix/workspaces/1/document.txt'),
    /outside the configured prefix/,
  );
  assert.equal(requests, 0);
});

test('S3 storage treats missing deletes as idempotent and bounds remote failures', async () => {
  const missing = new S3DocumentStorage({
    accessKeyId: 'test-access-key',
    bucket: 'primalthrum-documents',
    endpoint: 'https://objects.example.test',
    fetchImpl: async () => new Response('provider error with customer material', { status: 404 }),
    prefix: 'tenant-data',
    region: 'us-east-1',
    secretAccessKey: 'test-secret-key',
  });
  await missing.delete('s3://primalthrum-documents/tenant-data/workspaces/1/document.txt');
  await assert.rejects(
    missing.read('s3://primalthrum-documents/tenant-data/workspaces/1/document.txt'),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      assert.match(message, /status 404/);
      assert.equal(message.includes('customer material'), false);
      return true;
    },
  );
});

test('storage configuration fails closed in production and supports explicit development providers', () => {
  assert.throws(
    () => createDocumentFileStorage({ NODE_ENV: 'production' }),
    /DOCUMENT_STORAGE_PROVIDER=s3 is required/,
  );
  assert.throws(
    () => createDocumentFileStorage({
      NODE_ENV: 'production',
      DOCUMENT_STORAGE_PROVIDER: 's3',
      OBJECT_STORAGE_ENDPOINT: 'http://minio:9000',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'access',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
      OBJECT_STORAGE_BUCKET: 'primalthrum-documents',
      OBJECT_STORAGE_REGION: 'us-east-1',
    }),
    /must use HTTPS/,
  );
  assert.throws(
    () => createDocumentFileStorage({ DOCUMENT_STORAGE_PROVIDER: 's3' }),
    /OBJECT_STORAGE_ENDPOINT is required/,
  );
  assert.ok(createDocumentFileStorage({
    DOCUMENT_STORAGE_PROVIDER: 'local',
    DOCUMENT_STORAGE_DIR: '/tmp/primalthrum-storage-config-test',
  }) instanceof LocalDocumentStorage);
  assert.ok(createDocumentFileStorage({
    DOCUMENT_STORAGE_PROVIDER: 's3',
    OBJECT_STORAGE_ENDPOINT: 'http://127.0.0.1:9000',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'access',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
    OBJECT_STORAGE_BUCKET: 'primalthrum-documents',
    OBJECT_STORAGE_REGION: 'us-east-1',
  }) instanceof S3DocumentStorage);
});
