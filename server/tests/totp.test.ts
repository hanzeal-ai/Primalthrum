import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  encodeBase32,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpAt,
  verifyTotp,
} from '../src/services/totp';

test('TOTP matches RFC 6238 SHA-1 vectors', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ] as const;
  for (const [timestampSeconds, expected] of vectors) {
    assert.equal(totpAt(secret, timestampSeconds * 1000, { digits: 8 }), expected);
  }
});

test('TOTP verification uses a one-step window and returns the accepted step', () => {
  const secret = encodeBase32(Buffer.from('12345678901234567890', 'ascii'));
  const timestamp = 1_234_567_890_000;
  const previous = totpAt(secret, timestamp - 30_000);
  const expectedStep = Math.floor((timestamp - 30_000) / 1000 / 30);
  assert.equal(verifyTotp(secret, previous, timestamp), expectedStep);
  assert.equal(verifyTotp(secret, totpAt(secret, timestamp - 60_000), timestamp), null);
  assert.equal(verifyTotp(secret, 'not-a-code', timestamp), null);
});

test('recovery codes carry 120 random bits and normalize before hashing', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((code) => /^[A-Z2-7]{6}(?:-[A-Z2-7]{6}){3}$/.test(code)));
  assert.equal(normalizeRecoveryCode(codes[0].toLowerCase()), codes[0].replace(/-/g, ''));
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase()));
});
