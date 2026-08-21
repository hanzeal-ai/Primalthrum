import assert from 'node:assert/strict';

import {
  ClamAvDocumentMalwareScanner,
  DocumentThreatDetectedError,
} from '../services/documentMalwareScanner';
import { parseDocumentUpload } from '../services/documentUpload';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

async function main(): Promise<void> {
  const host = process.env.CLAMAV_HOST?.trim();
  if (!host) throw new Error('CLAMAV_HOST is required');
  const scanner = new ClamAvDocumentMalwareScanner(
    host,
    integerEnvironment('CLAMAV_PORT', 3310),
    integerEnvironment('CLAMAV_TIMEOUT_MS', 10_000),
  );

  await scanner.healthCheck();
  await scanner.scan(upload('clean.txt', 'primalthrum clean document'));
  await assert.rejects(
    scanner.scan(upload('eicar.txt', EICAR)),
    (error: unknown) => (
      error instanceof DocumentThreatDetectedError
      && error.threatName.toLowerCase().includes('eicar')
    ),
  );
  process.stdout.write('ClamAV production scanner smoke passed\n');
}

function upload(filename: string, content: string) {
  return parseDocumentUpload({
    filename,
    mimeType: 'text/plain',
    dataBase64: Buffer.from(content).toString('base64'),
  });
}

function integerEnvironment(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  const parsed = value ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} is invalid`);
  return parsed;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'ClamAV smoke failed'}\n`);
  process.exitCode = 1;
});
