import { type DatabaseParameter } from '../../db/asyncAdapter';
import { type TransferColumn } from './types';

function booleanValue(value: unknown): boolean {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw new Error(`database transfer cannot convert value to boolean: ${String(value)}`);
}

function timestampValue(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') {
    throw new Error(`database transfer cannot convert value to timestamp: ${String(value)}`);
  }
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const normalized = explicitZone ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = new Date(normalized);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error(`database transfer timestamp is invalid: ${value}`);
  }
  return timestamp;
}

function bytesValue(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'base64'));
  throw new Error('database transfer cannot convert value to bytes');
}

function canonicalDecimal(value: unknown): string {
  const raw = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new Error(`database transfer decimal is invalid: ${raw}`);
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction.length > 0) ? '-' : '';
  return `${sign}${integer}${fraction ? `.${fraction}` : ''}`;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableJson(entry)]),
    );
  }
  return value;
}

export function toTargetTransferValue(value: unknown, targetType: string): DatabaseParameter {
  if (value === null || value === undefined) return null;
  if (targetType === 'bool') return booleanValue(value);
  if (targetType === 'timestamptz' || targetType === 'timestamp') return timestampValue(value);
  if (targetType === 'bytea') return bytesValue(value);
  if (targetType === 'int8' || targetType === 'numeric' || targetType === 'decimal') {
    return canonicalDecimal(value);
  }
  if (targetType === 'json' || targetType === 'jsonb') {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date || value instanceof Uint8Array) return value;
  throw new Error(`database transfer value type is unsupported for ${targetType}`);
}

function canonicalValue(value: unknown, targetType: string): unknown {
  if (value === null || value === undefined) return null;
  if (targetType === 'bool') return booleanValue(value);
  if (targetType === 'timestamptz' || targetType === 'timestamp') {
    return timestampValue(value).toISOString();
  }
  if (targetType === 'bytea') return Buffer.from(bytesValue(value)).toString('base64');
  if (targetType === 'int8' || targetType === 'numeric' || targetType === 'decimal') {
    return canonicalDecimal(value);
  }
  if (targetType === 'json' || targetType === 'jsonb') {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return stableJson(parsed);
  }
  return value;
}

export function canonicalTransferRow(
  row: Record<string, unknown>,
  columns: readonly TransferColumn[],
): string {
  return JSON.stringify(columns.map((column) => canonicalValue(row[column.name], column.targetType)));
}
