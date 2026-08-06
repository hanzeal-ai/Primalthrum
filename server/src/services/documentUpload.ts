import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES: Record<string, ReadonlySet<string>> = {
  '.txt': new Set(['text/plain']),
  '.md': new Set(['text/markdown', 'text/plain']),
  '.markdown': new Set(['text/markdown', 'text/plain']),
  '.json': new Set(['application/json', 'text/json', 'text/plain']),
  '.csv': new Set(['text/csv', 'application/csv', 'text/plain']),
};

export interface DocumentUploadInput {
  filename?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
  collection?: unknown;
}

export interface ParsedDocumentUpload {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
  contentSha256: string;
  content: string;
  collection: string;
}

export function parseDocumentUpload(input: DocumentUploadInput): ParsedDocumentUpload {
  const filename = normalizedFilename(input.filename);
  const mimeType = normalizeMimeType(input.mimeType);
  const extension = extname(filename).toLowerCase();
  const allowedTypes = ALLOWED_TYPES[extension];
  if (!allowedTypes || !allowedTypes.has(mimeType)) {
    throw new Error('document type is not supported or does not match the filename');
  }

  const encoded = requiredText(input.dataBase64, 'dataBase64');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('document dataBase64 is invalid');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw new Error('document cannot be empty');
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error(`document exceeds ${MAX_DOCUMENT_BYTES} byte limit`);
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('document must use valid UTF-8 encoding');
  }
  if (content.includes('\0')) throw new Error('document contains unsupported null bytes');
  content = content.replace(/\r\n?/g, '\n').trim();
  if (!content) throw new Error('document cannot be empty');
  if (extension === '.json') {
    try {
      JSON.parse(content);
    } catch {
      throw new Error('JSON document is invalid');
    }
  }

  return {
    filename,
    mimeType,
    sizeBytes: bytes.length,
    bytes,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    content,
    collection: optionalText(input.collection) || 'default',
  };
}

function normalizedFilename(value: unknown): string {
  const filename = requiredText(value, 'filename').normalize('NFKC');
  if (
    filename.length > 255
    || filename.includes('\\')
    || basename(filename) !== filename
    || filename === '.'
    || filename === '..'
  ) {
    throw new Error('filename must be a bounded base name');
  }
  return filename;
}

function normalizeMimeType(value: unknown): string {
  const normalized = requiredText(value, 'mimeType').split(';', 1)[0]!.toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(normalized)) {
    throw new Error('mimeType is invalid');
  }
  return normalized;
}

function requiredText(value: unknown, name: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
