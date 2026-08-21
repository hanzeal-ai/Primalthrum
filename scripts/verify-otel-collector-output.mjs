import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('collector output path is required');

const payloads = readFileSync(outputPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));
const resources = payloads.flatMap((payload) => payload.resourceSpans ?? []);

const server = resourceFor(resources, 'primalthrum-server-smoke');
const serverSpan = spanNamed(server, 'GET /healthz');
assert.equal(attribute(server.resource?.attributes, 'deployment.environment.name'), 'production-smoke');
assert.equal(attribute(serverSpan.attributes, 'http.route'), '/healthz');
assert.equal(attribute(serverSpan.attributes, 'http.response.status_code'), '200');

const worker = resourceFor(resources, 'primalthrum-worker-smoke');
const workerSpan = spanNamed(worker, 'primalthrum.worker.durable_job.process');
assert.equal(attribute(workerSpan.attributes, 'messaging.destination.name'), 'durable_job');
assert.equal(attribute(workerSpan.attributes, 'primalthrum.worker.outcome'), 'succeeded');

function resourceFor(entries, serviceName) {
  const resource = entries.find((entry) => (
    attribute(entry.resource?.attributes, 'service.name') === serviceName
  ));
  assert.ok(resource, `missing ${serviceName} resource`);
  return resource;
}

function spanNamed(resource, name) {
  const spans = (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []);
  const span = spans.find((entry) => entry.name === name);
  assert.ok(span, `missing ${name} span`);
  return span;
}

function attribute(attributes = [], key) {
  const value = attributes.find((entry) => entry.key === key)?.value ?? {};
  return value.stringValue ?? value.intValue;
}

process.stdout.write('OpenTelemetry collector output verified\n');
