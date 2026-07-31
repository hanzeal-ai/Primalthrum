import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const PASSWORD_SCHEME = 'scrypt';
const INVALID_LOGIN_HASH = 'scrypt:9f4c44c2d1e96f996b2cb4f16d4bb723:a4335cf9e027077c49fbbfab0341132dcddb990f8ac994d03dacf9f5aeacb6e23764091b6185e438885c11936d877da6798a4c5d23c55df8c5f2a2eb029d46e0';

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

export function verifyPasswordOrDummy(password: string, encodedHash: string | null): boolean {
  const verified = verifyPassword(password, encodedHash ?? INVALID_LOGIN_HASH);
  return encodedHash !== null && verified;
}
