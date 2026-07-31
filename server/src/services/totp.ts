import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_PERIOD_SECONDS = 30;

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpAt(
  secret: string,
  timestampMs = Date.now(),
  options: TotpOptions = {},
): string {
  const periodSeconds = options.periodSeconds ?? DEFAULT_PERIOD_SECONDS;
  const step = Math.floor(timestampMs / 1000 / periodSeconds);
  return hotp(secret, step, options.digits ?? 6);
}

export function verifyTotp(
  secret: string,
  code: unknown,
  timestampMs = Date.now(),
  window = 1,
): number | null {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return null;
  const currentStep = Math.floor(timestampMs / 1000 / DEFAULT_PERIOD_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) continue;
    const candidate = hotp(secret, step, 6);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) return step;
  }
  return null;
}

export function createTotpUri(input: {
  accountName: string;
  issuer: string;
  secret: string;
}): string {
  const label = `${input.issuer}:${input.accountName}`;
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: String(DEFAULT_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => (
    encodeBase32(randomBytes(15)).match(/.{1,6}/g)?.join('-') ?? ''
  ));
}

export function hashRecoveryCode(code: unknown): string {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex');
}

export function normalizeRecoveryCode(code: unknown): string {
  if (typeof code !== 'string') return '';
  const normalized = code.toUpperCase().replace(/[^A-Z2-7]/g, '');
  return normalized.length === 24 ? normalized : '';
}

export function encodeBase32(value: Buffer): string {
  let bits = 0;
  let bitCount = 0;
  let output = '';
  for (const byte of value) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      output += BASE32_ALPHABET[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  return output;
}

function hotp(secret: string, counter: number, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  );
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new Error('invalid Base32 secret');
  let bits = 0;
  let bitCount = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bytes.push((bits >>> (bitCount - 8)) & 0xff);
      bitCount -= 8;
    }
  }
  return Buffer.from(bytes);
}

function normalizeTotpCode(code: unknown): string {
  if (typeof code !== 'string') return '';
  const normalized = code.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(normalized) ? normalized : '';
}
