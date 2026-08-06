import { createHash, createHmac } from 'node:crypto';

import {
  documentObjectPath,
  type DocumentFileStorage,
  type SaveDocumentFileInput,
  type StoredDocumentFile,
} from './fileStorage';

export interface S3DocumentStorageOptions {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  prefix?: string;
  region: string;
  requestTimeoutMs?: number;
  secretAccessKey: string;
  sessionToken?: string;
}

interface S3RequestInput {
  body?: string;
  key?: string;
  method: 'DELETE' | 'GET' | 'HEAD' | 'PUT';
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export class S3DocumentStorage implements DocumentFileStorage {
  private readonly accessKeyId: string;
  private readonly bucket: string;
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly prefix: string;
  private readonly region: string;
  private readonly requestTimeoutMs: number;
  private readonly secretAccessKey: string;
  private readonly sessionToken: string;

  constructor(options: S3DocumentStorageOptions) {
    this.accessKeyId = required(options.accessKeyId, 'S3 access key ID');
    this.secretAccessKey = required(options.secretAccessKey, 'S3 secret access key');
    this.region = required(options.region, 'S3 region');
    this.bucket = bucketName(options.bucket);
    this.endpoint = endpointUrl(options.endpoint);
    this.prefix = objectPrefix(options.prefix ?? 'primalthrum');
    this.sessionToken = options.sessionToken?.trim() ?? '';
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs ?? 10_000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async save(input: SaveDocumentFileInput): Promise<StoredDocumentFile> {
    const key = this.scopedKey(documentObjectPath(input));
    await this.request({ method: 'PUT', key, body: input.content });
    return { storageRef: `s3://${this.bucket}/${key}` };
  }

  async read(storageRef: string): Promise<string> {
    const response = await this.request({ method: 'GET', key: this.keyFromRef(storageRef) });
    return response.text();
  }

  async delete(storageRef: string): Promise<void> {
    await this.request({ method: 'DELETE', key: this.keyFromRef(storageRef) }, true);
  }

  async healthCheck(): Promise<void> {
    await this.request({ method: 'HEAD' });
  }

  private scopedKey(path: string): string {
    return this.prefix ? `${this.prefix}/${path}` : path;
  }

  private keyFromRef(storageRef: string): string {
    let parsed: URL;
    try {
      parsed = new URL(storageRef);
    } catch {
      throw new Error('unsupported document storage ref');
    }
    if (
      parsed.protocol !== 's3:'
      || parsed.hostname !== this.bucket
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('document storage ref is outside the configured bucket');
    }
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
    const requiredPrefix = this.prefix ? `${this.prefix}/` : '';
    if (!key || !key.startsWith(requiredPrefix) || key.split('/').some(unsafeSegment)) {
      throw new Error('document storage ref is outside the configured prefix');
    }
    return key;
  }

  private async request(input: S3RequestInput, allowNotFound = false): Promise<Response> {
    const body = input.body ?? '';
    const payloadHash = body ? sha256(body) : EMPTY_SHA256;
    const date = this.now();
    if (Number.isNaN(date.getTime())) throw new Error('S3 signing clock is invalid');
    const amzDate = awsTimestamp(date);
    const dateStamp = amzDate.slice(0, 8);
    const path = this.requestPath(input.key);
    const url = new URL(this.endpoint.toString());
    url.pathname = path;
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.sessionToken) headers['x-amz-security-token'] = this.sessionToken;
    const signedHeaderNames = Object.keys(headers).sort();
    const signedHeaders = signedHeaderNames.join(';');
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
    const canonicalRequest = [
      input.method,
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join('\n');
    const signature = hmacHex(
      hmac(hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, dateStamp), this.region), 's3'), 'aws4_request'),
      stringToSign,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: input.method,
        body: input.method === 'PUT' ? body : undefined,
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          ...(input.method === 'PUT' ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
        },
        signal: controller.signal,
      });
      if (response.ok || (allowNotFound && response.status === 404)) return response;
      throw new Error(`S3 ${input.method} failed with status ${response.status}`);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`S3 ${input.method} timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestPath(key?: string): string {
    const endpointPath = this.endpoint.pathname.replace(/\/+$/, '');
    const segments = [this.bucket, ...(key ? key.split('/') : [])];
    return `${endpointPath}/${segments.map(awsUriEncode).join('/')}`.replace(/^\/\//, '/');
  }
}

function endpointUrl(value: string): URL {
  const endpoint = new URL(required(value, 'S3 endpoint'));
  if (!['http:', 'https:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('S3 endpoint must be an HTTP(S) origin without credentials, query, or fragment');
  }
  return endpoint;
}

function bucketName(value: string): string {
  const bucket = required(value, 'S3 bucket');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes('..') || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)) {
    throw new Error('S3 bucket name is invalid');
  }
  return bucket;
}

function objectPrefix(value: string): string {
  const prefix = value.trim().replace(/^\/+|\/+$/g, '');
  if (prefix && (!/^[a-zA-Z0-9._/-]{1,256}$/.test(prefix) || prefix.split('/').some(unsafeSegment))) {
    throw new Error('S3 object prefix is invalid');
  }
  return prefix;
}

function unsafeSegment(value: string): boolean {
  return !value || value === '.' || value === '..';
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 250 || value > 60_000) {
    throw new Error('S3 request timeout must be between 250 and 60000 milliseconds');
  }
  return Math.floor(value);
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function awsTimestamp(value: Date): string {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}
