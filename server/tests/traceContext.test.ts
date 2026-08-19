import assert from 'node:assert/strict';
import test from 'node:test';

import { createServerTraceContext, formatTraceparent } from '../src/services/traceContext';

test('server trace context continues a valid W3C parent with a new span', () => {
  const parentTraceId = '11111111111111111111111111111111';
  const parentSpanId = '2222222222222222';
  const context = createServerTraceContext(`00-${parentTraceId}-${parentSpanId}-01`);

  assert.equal(context.traceId, parentTraceId);
  assert.equal(context.parentSpanId, parentSpanId);
  assert.equal(context.sampled, true);
  assert.match(context.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(context.spanId, parentSpanId);
  assert.equal(formatTraceparent(context), `00-${parentTraceId}-${context.spanId}-01`);
});

test('server trace context rejects malformed or zero identifiers and preserves sampling', () => {
  for (const value of [
    'malformed',
    '00-00000000000000000000000000000000-2222222222222222-01',
    '00-11111111111111111111111111111111-0000000000000000-01',
  ]) {
    const context = createServerTraceContext(value);
    assert.match(context.traceId, /^[0-9a-f]{32}$/);
    assert.notEqual(context.traceId, '11111111111111111111111111111111');
    assert.equal(context.parentSpanId, undefined);
  }

  const unsampled = createServerTraceContext(
    '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
  );
  assert.equal(unsampled.sampled, false);
  assert.equal(unsampled.traceFlags, '00');
});
