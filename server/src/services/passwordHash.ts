import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const PASSWORD_SCHEME = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${PASSWORD_SCHEME}:${salt}:${hash}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const [scheme, salt, expectedHash] = encodedHash.split(':');
  if (scheme !== PASSWORD_SCHEME || !salt || !expectedHash) {
    return false;
  }

  const expected = Buffer.from(expectedHash, 'hex');
  const actual = scryptSync(password, salt, KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
