import { randomUUID } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';

export interface OperatorAuditRecord {
  id: number;
  eventId: string;
  operatorUserId: number | null;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AuditRow {
  id: number;
  event_id: string;
  operator_user_id: number | null;
  event_type: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: string;
}

export class OperatorAuditRepository {
  constructor(private readonly db: DatabaseAdapter) {
    initializeSchema(db);
  }

  record(input: {
    operatorUserId?: number | null;
    eventType: string;
    targetType?: string;
    targetId?: string | number;
    metadata?: Record<string, unknown>;
  }): OperatorAuditRecord {
    const eventType = normalizeKey(input.eventType, 'event type');
    const targetType = input.targetType ? normalizeKey(input.targetType, 'target type') : '';
    const targetId = String(input.targetId ?? '').slice(0, 128);
    const eventId = randomUUID();
    this.db.run(`
      INSERT INTO operator_audit_events (
        event_id, operator_user_id, event_type, target_type, target_id, metadata_json
      ) VALUES (
        ${sqlValue(eventId)}, ${sqlValue(input.operatorUserId ?? null)},
        ${sqlValue(eventType)}, ${sqlValue(targetType)}, ${sqlValue(targetId)},
        ${sqlValue(JSON.stringify(sanitizeMetadata(input.metadata ?? {})))}
      );
    `);
    const row = this.db.query<AuditRow>(`
      SELECT id, event_id, operator_user_id, event_type, target_type,
        target_id, metadata_json, created_at
      FROM operator_audit_events
      WHERE event_id = ${sqlValue(eventId)}
      LIMIT 1;
    `)[0];
    if (!row) throw new Error('operator audit event could not be loaded');
    return toAuditRecord(row);
  }

  list(limit = 100): OperatorAuditRecord[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.query<AuditRow>(`
      SELECT id, event_id, operator_user_id, event_type, target_type,
        target_id, metadata_json, created_at
      FROM operator_audit_events
      ORDER BY id DESC
      LIMIT ${boundedLimit};
    `).map(toAuditRecord);
  }
}

const SENSITIVE_KEY = /(password|token|secret|authorization|cookie|payload|content)/i;

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(value, 0);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 2) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'number') {
      sanitized[key] = entry;
      continue;
    }
    if (typeof entry === 'string') {
      sanitized[key] = entry.slice(0, 240);
      continue;
    }
    if (Array.isArray(entry)) {
      sanitized[key] = entry.slice(0, 20).map((item) => (
        typeof item === 'string' ? item.slice(0, 120) : item
      )).filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
      continue;
    }
    if (entry && typeof entry === 'object') {
      sanitized[key] = sanitizeObject(entry as Record<string, unknown>, depth + 1);
    }
  }
  return sanitized;
}

function normalizeKey(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(normalized)) {
    throw new Error(`operator audit ${label} is invalid`);
  }
  return normalized;
}

function toAuditRecord(row: AuditRow): OperatorAuditRecord {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    operatorUserId: row.operator_user_id === null ? null : Number(row.operator_user_id),
    eventType: row.event_type,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}
