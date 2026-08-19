import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadProductionCompose(environmentFile = 'deploy/production.env.example') {
  const result = spawnSync('docker', [
    'compose',
    '--env-file',
    environmentFile,
    '-f',
    'docker-compose.production.yml',
    'config',
    '--format',
    'json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'production Compose rendering failed');
  }
  return JSON.parse(result.stdout);
}

export function verifyProductionCompose(config) {
  const serviceNames = Object.keys(config.services ?? {}).sort();
  assert.deepEqual(serviceNames, ['agent', 'server', 'web', 'worker']);
  for (const name of serviceNames) {
    const service = config.services[name];
    assert.equal(service.init, true, `${name} must enable an init process`);
    assert.equal(service.read_only, true, `${name} root filesystem must be read-only`);
    assert.equal(service.restart, 'unless-stopped', `${name} must have a restart policy`);
    assert.ok(service.cap_drop?.includes('ALL'), `${name} must drop all Linux capabilities`);
    assert.ok(
      service.security_opt?.includes('no-new-privileges:true'),
      `${name} must disable privilege escalation`,
    );
    assert.ok(service.healthcheck?.test?.length, `${name} must define a health check`);
    assert.ok(service.build?.dockerfile, `${name} must use a repository Dockerfile`);
    assert.notEqual(service.image?.split(':').at(-1), 'latest', `${name} image must be versioned`);
    for (const volume of service.volumes ?? []) {
      assert.notEqual(volume.type, 'bind', `${name} must not mount host source paths`);
    }
  }

  assert.equal(config.services.server.environment.NODE_ENV, 'production');
  assert.equal(config.services.server.environment.BACKGROUND_WORKER_MODE, 'external');
  assert.equal(config.services.server.environment.OTEL_TRACES_EXPORTER, 'otlp');
  assert.equal(config.services.server.environment.OTEL_SERVICE_NAME, 'primalthrum-server');
  assert.equal(config.services.worker.environment.OTEL_SERVICE_NAME, 'primalthrum-worker');
  assert.match(config.services.server.environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, /^https:\/\//);
  assert.equal(
    config.services.worker.environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    config.services.server.environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  );
  assert.equal(config.services.worker.command?.join(' '), 'node dist/worker.js');
  assert.equal(config.services.web.environment.SERVER_PROXY_TARGET, 'http://server:3000');
  assert.match(config.services.server.environment.DATABASE_URL, /^postgres(ql)?:\/\//);
  assert.match(config.services.server.environment.OBJECT_STORAGE_ENDPOINT, /^https:\/\//);
  assert.equal(config.services.web.ports?.length, 1, 'Web must expose exactly one port');
  for (const name of ['agent', 'server', 'worker']) {
    assert.equal(config.services[name].ports, undefined, `${name} must not publish host ports`);
  }
  assert.notEqual(config.networks?.backend?.internal, true, 'backend services require managed-service egress');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const environmentFile = process.env.PRODUCTION_ENV_FILE
    ? resolve(process.env.PRODUCTION_ENV_FILE)
    : join(ROOT, 'deploy', 'production.env.example');
  verifyProductionCompose(loadProductionCompose(environmentFile));
  console.log('[production-compose] topology verified');
}
