import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalTransferRow,
  toTargetTransferValue,
} from '../src/services/database-transfer/normalization';
import { type TransferColumn } from '../src/services/database-transfer/types';

test('database transfer normalization aligns SQLite and PostgreSQL scalar representations', () => {
  const columns: TransferColumn[] = [
    { name: 'enabled', targetType: 'bool', primaryKeyPosition: 0, identity: false },
    { name: 'created_at', targetType: 'timestamptz', primaryKeyPosition: 0, identity: false },
    { name: 'amount', targetType: 'numeric', primaryKeyPosition: 0, identity: false },
    { name: 'payload', targetType: 'jsonb', primaryKeyPosition: 0, identity: false },
    { name: 'bytes', targetType: 'bytea', primaryKeyPosition: 0, identity: false },
  ];
  const bytes = Uint8Array.from([1, 2, 3]);

  const sqlite = canonicalTransferRow({
    enabled: 1,
    created_at: '2026-08-10 12:00:00',
    amount: '0010.5000',
    payload: '{"z":1,"a":{"b":2}}',
    bytes,
  }, columns);
  const postgres = canonicalTransferRow({
    enabled: true,
    created_at: new Date('2026-08-10T12:00:00.000Z'),
    amount: '10.5',
    payload: { a: { b: 2 }, z: 1 },
    bytes: Buffer.from(bytes),
  }, columns);

  assert.equal(sqlite, postgres);
  assert.equal(toTargetTransferValue(0, 'bool'), false);
  assert.equal((toTargetTransferValue('2026-08-10 12:00:00', 'timestamptz') as Date).toISOString(),
    '2026-08-10T12:00:00.000Z');
});

test('database transfer normalization fails closed for malformed typed values', () => {
  assert.throws(() => toTargetTransferValue('sometimes', 'bool'), /cannot convert value to boolean/);
  assert.throws(() => toTargetTransferValue('not-a-date', 'timestamptz'), /timestamp is invalid/);
  assert.throws(() => toTargetTransferValue('1.2.3', 'numeric'), /decimal is invalid/);
});
