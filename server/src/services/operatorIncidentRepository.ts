import { randomUUID } from 'node:crypto';

import { initializeSchema } from '../db/schema';
import { SqliteDatabase, sqlValue } from '../db/sqlite';

export const INCIDENT_SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export const INCIDENT_SCOPES = ['platform', 'multi_workspace', 'workspace'] as const;
export const INCIDENT_EVENT_TYPES = ['note', 'mitigation', 'customer_update'] as const;

export type OperatorIncidentSeverity = typeof INCIDENT_SEVERITIES[number];
export type OperatorIncidentStatus = typeof INCIDENT_STATUSES[number];
export type OperatorIncidentScope = typeof INCIDENT_SCOPES[number];
export type OperatorIncidentEventType = typeof INCIDENT_EVENT_TYPES[number];

export interface OperatorIncidentSummary {
  id: number;
  incidentRef: string;
  title: string;
  severity: OperatorIncidentSeverity;
  status: OperatorIncidentStatus;
  impactScope: OperatorIncidentScope;
  workspaceId: number | null;
  workspaceName: string | null;
  summary: string;
  startedAt: string;
  resolvedAt: string | null;
  ownerOperatorId: number | null;
  revision: number;
  eventCount: number;
  createdByOperatorId: number;
  updatedByOperatorId: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperatorIncidentEvent {
  id: number;
  eventId: string;
  incidentId: number;
  operatorUserId: number;
  eventType: 'created' | 'updated' | 'status_changed' | OperatorIncidentEventType;
  message: string;
  fromStatus: string;
  toStatus: string;
  createdAt: string;
}

export interface OperatorIncidentDetail extends OperatorIncidentSummary {
  events: OperatorIncidentEvent[];
}

interface IncidentRow {
  id: number;
  incident_ref: string;
  title: string;
  severity: OperatorIncidentSeverity;
  status: OperatorIncidentStatus;
  impact_scope: OperatorIncidentScope;
  workspace_id: number | null;
  workspace_name: string | null;
  summary: string;
  started_at: string;
  resolved_at: string | null;
  owner_operator_id: number | null;
  revision: number;
  event_count: number;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string;
  updated_at: string;
}

interface IncidentEventRow {
  id: number;
  event_id: string;
  incident_id: number;
  operator_user_id: number;
  event_type: OperatorIncidentEvent['eventType'];
  message: string;
  from_status: string;
  to_status: string;
  created_at: string;
}

export class OperatorIncidentRepository {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    initializeSchema(db);
  }

  list(limit = 100): OperatorIncidentSummary[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.query<IncidentRow>(`
      ${incidentSelect()}
      ORDER BY
        CASE incident.status WHEN 'resolved' THEN 1 ELSE 0 END,
        CASE incident.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END,
        incident.started_at DESC,
        incident.id DESC
      LIMIT ${boundedLimit};
    `).map(toIncidentSummary);
  }

  find(id: number): OperatorIncidentDetail | null {
    const row = this.db.query<IncidentRow>(`
      ${incidentSelect()}
      WHERE incident.id = ${sqlValue(id)} LIMIT 1;
    `)[0];
    if (!row) return null;
    return {
      ...toIncidentSummary(row),
      events: this.db.query<IncidentEventRow>(`
        SELECT * FROM operator_incident_events
        WHERE incident_id = ${sqlValue(id)}
        ORDER BY id ASC;
      `).map(toIncidentEvent),
    };
  }

  create(input: {
    title: unknown;
    severity: unknown;
    impactScope: unknown;
    workspaceId: unknown;
    summary: unknown;
    startedAt: unknown;
    ownerOperatorId: unknown;
    operatorUserId: number;
  }): OperatorIncidentDetail {
    const incidentRef = `INC-${randomUUID().slice(0, 8).toUpperCase()}`;
    const title = boundedText(input.title, 'incident title', 5, 160);
    const severity = incidentSeverity(input.severity);
    const impactScope = incidentScope(input.impactScope);
    const workspaceId = scopedWorkspace(impactScope, input.workspaceId);
    if (workspaceId !== null && !this.workspaceExists(workspaceId)) {
      throw new Error('workspace not found');
    }
    const summary = boundedText(input.summary, 'incident summary', 12, 2000);
    const startedAt = isoTimestamp(input.startedAt, 'incident start time');
    if (new Date(startedAt).valueOf() > this.now().valueOf()) {
      throw new Error('incident start time cannot be in the future');
    }
    const ownerOperatorId = optionalPositiveInteger(input.ownerOperatorId, 'incident owner');
    if (ownerOperatorId !== null && !this.operatorExists(ownerOperatorId)) {
      throw new Error('incident owner not found');
    }
    const now = this.now().toISOString();
    const eventId = randomUUID();
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO operator_incidents (
        incident_ref, title, severity, status, impact_scope, workspace_id,
        summary, started_at, owner_operator_id, created_by_operator_id,
        updated_by_operator_id, created_at, updated_at
      ) VALUES (
        ${sqlValue(incidentRef)}, ${sqlValue(title)}, ${sqlValue(severity)},
        'investigating', ${sqlValue(impactScope)}, ${sqlValue(workspaceId)},
        ${sqlValue(summary)}, ${sqlValue(startedAt)}, ${sqlValue(ownerOperatorId)},
        ${sqlValue(input.operatorUserId)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(now)}, ${sqlValue(now)}
      );
      INSERT INTO operator_incident_events (
        event_id, incident_id, operator_user_id, event_type, message,
        from_status, to_status, created_at
      ) SELECT
        ${sqlValue(eventId)}, id, ${sqlValue(input.operatorUserId)}, 'created',
        'Incident created', '', 'investigating', ${sqlValue(now)}
      FROM operator_incidents WHERE incident_ref = ${sqlValue(incidentRef)};
      COMMIT;
    `);
    const created = this.db.query<{ id: number }>(`
      SELECT id FROM operator_incidents WHERE incident_ref = ${sqlValue(incidentRef)} LIMIT 1;
    `)[0];
    if (!created) throw new Error('incident could not be created');
    return this.requiredIncident(created.id);
  }

  update(id: number, input: {
    title: unknown;
    severity: unknown;
    status: unknown;
    impactScope: unknown;
    workspaceId: unknown;
    summary: unknown;
    ownerOperatorId: unknown;
    expectedRevision: unknown;
    operatorUserId: number;
  }): OperatorIncidentDetail {
    const existing = this.requiredIncident(id);
    const expectedRevision = positiveInteger(input.expectedRevision, 'incident revision');
    if (existing.revision !== expectedRevision) throw new Error('incident revision conflict');
    const title = boundedText(input.title, 'incident title', 5, 160);
    const severity = incidentSeverity(input.severity);
    const status = incidentStatus(input.status);
    assertStatusTransition(existing.status, status);
    const impactScope = incidentScope(input.impactScope);
    const workspaceId = scopedWorkspace(impactScope, input.workspaceId);
    if (workspaceId !== null && !this.workspaceExists(workspaceId)) {
      throw new Error('workspace not found');
    }
    const summary = boundedText(input.summary, 'incident summary', 12, 2000);
    const ownerOperatorId = optionalPositiveInteger(input.ownerOperatorId, 'incident owner');
    if (ownerOperatorId !== null && !this.operatorExists(ownerOperatorId)) {
      throw new Error('incident owner not found');
    }
    const now = this.now().toISOString();
    const resolvedAt = status === 'resolved'
      ? existing.resolvedAt ?? now
      : null;
    const nextRevision = expectedRevision + 1;
    const eventId = randomUUID();
    const eventType = status === existing.status ? 'updated' : 'status_changed';
    const message = status === existing.status
      ? 'Incident details updated'
      : `Status changed from ${existing.status} to ${status}`;
    this.db.run(`
      BEGIN IMMEDIATE;
      UPDATE operator_incidents
      SET title = ${sqlValue(title)},
          severity = ${sqlValue(severity)},
          status = ${sqlValue(status)},
          impact_scope = ${sqlValue(impactScope)},
          workspace_id = ${sqlValue(workspaceId)},
          summary = ${sqlValue(summary)},
          resolved_at = ${sqlValue(resolvedAt)},
          owner_operator_id = ${sqlValue(ownerOperatorId)},
          revision = ${sqlValue(nextRevision)},
          updated_by_operator_id = ${sqlValue(input.operatorUserId)},
          updated_at = ${sqlValue(now)}
      WHERE id = ${sqlValue(id)} AND revision = ${sqlValue(expectedRevision)};
      INSERT INTO operator_incident_events (
        event_id, incident_id, operator_user_id, event_type, message,
        from_status, to_status, created_at
      ) SELECT
        ${sqlValue(eventId)}, ${sqlValue(id)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(eventType)}, ${sqlValue(message)}, ${sqlValue(existing.status)},
        ${sqlValue(status)}, ${sqlValue(now)}
      WHERE changes() = 1;
      COMMIT;
    `);
    this.assertEvent(eventId, 'incident revision conflict');
    return this.requiredIncident(id);
  }

  appendEvent(id: number, input: {
    eventType: unknown;
    message: unknown;
    operatorUserId: number;
  }): OperatorIncidentEvent {
    this.requiredIncident(id);
    const eventType = incidentEventType(input.eventType);
    const message = boundedText(input.message, 'incident event message', 3, 2000);
    const eventId = randomUUID();
    const now = this.now().toISOString();
    this.db.run(`
      INSERT INTO operator_incident_events (
        event_id, incident_id, operator_user_id, event_type, message, created_at
      ) VALUES (
        ${sqlValue(eventId)}, ${sqlValue(id)}, ${sqlValue(input.operatorUserId)},
        ${sqlValue(eventType)}, ${sqlValue(message)}, ${sqlValue(now)}
      );
    `);
    const created = this.db.query<IncidentEventRow>(`
      SELECT * FROM operator_incident_events WHERE event_id = ${sqlValue(eventId)} LIMIT 1;
    `)[0];
    if (!created) throw new Error('incident event could not be created');
    return toIncidentEvent(created);
  }

  private requiredIncident(id: number): OperatorIncidentDetail {
    const incident = this.find(id);
    if (!incident) throw new Error('incident not found');
    return incident;
  }

  private workspaceExists(id: number): boolean {
    return Boolean(this.db.query<{ id: number }>(`
      SELECT id FROM workspaces WHERE id = ${sqlValue(id)} LIMIT 1;
    `)[0]);
  }

  private operatorExists(id: number): boolean {
    return Boolean(this.db.query<{ id: number }>(`
      SELECT id FROM operator_users WHERE id = ${sqlValue(id)} AND status = 'active' LIMIT 1;
    `)[0]);
  }

  private assertEvent(eventId: string, message: string): void {
    const event = this.db.query<{ id: number }>(`
      SELECT id FROM operator_incident_events WHERE event_id = ${sqlValue(eventId)} LIMIT 1;
    `)[0];
    if (!event) throw new Error(message);
  }
}

function incidentSelect(): string {
  return `
    SELECT
      incident.*,
      workspace.name AS workspace_name,
      (SELECT COUNT(*) FROM operator_incident_events event
        WHERE event.incident_id = incident.id) AS event_count
    FROM operator_incidents incident
    LEFT JOIN workspaces workspace ON workspace.id = incident.workspace_id
  `;
}

function toIncidentSummary(row: IncidentRow): OperatorIncidentSummary {
  return {
    id: Number(row.id),
    incidentRef: row.incident_ref,
    title: row.title,
    severity: row.severity,
    status: row.status,
    impactScope: row.impact_scope,
    workspaceId: row.workspace_id === null ? null : Number(row.workspace_id),
    workspaceName: row.workspace_name,
    summary: row.summary,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    ownerOperatorId: row.owner_operator_id === null ? null : Number(row.owner_operator_id),
    revision: Number(row.revision),
    eventCount: Number(row.event_count),
    createdByOperatorId: Number(row.created_by_operator_id),
    updatedByOperatorId: Number(row.updated_by_operator_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIncidentEvent(row: IncidentEventRow): OperatorIncidentEvent {
  return {
    id: Number(row.id),
    eventId: row.event_id,
    incidentId: Number(row.incident_id),
    operatorUserId: Number(row.operator_user_id),
    eventType: row.event_type,
    message: row.message,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: row.created_at,
  };
}

function incidentSeverity(value: unknown): OperatorIncidentSeverity {
  if (typeof value !== 'string' || !INCIDENT_SEVERITIES.includes(value as OperatorIncidentSeverity)) {
    throw new Error('incident severity is invalid');
  }
  return value as OperatorIncidentSeverity;
}

function incidentStatus(value: unknown): OperatorIncidentStatus {
  if (typeof value !== 'string' || !INCIDENT_STATUSES.includes(value as OperatorIncidentStatus)) {
    throw new Error('incident status is invalid');
  }
  return value as OperatorIncidentStatus;
}

function incidentScope(value: unknown): OperatorIncidentScope {
  if (typeof value !== 'string' || !INCIDENT_SCOPES.includes(value as OperatorIncidentScope)) {
    throw new Error('incident impact scope is invalid');
  }
  return value as OperatorIncidentScope;
}

function incidentEventType(value: unknown): OperatorIncidentEventType {
  if (typeof value !== 'string' || !INCIDENT_EVENT_TYPES.includes(value as OperatorIncidentEventType)) {
    throw new Error('incident event type is invalid');
  }
  return value as OperatorIncidentEventType;
}

function scopedWorkspace(scope: OperatorIncidentScope, value: unknown): number | null {
  if (scope === 'workspace') return positiveInteger(value, 'workspace');
  if (value !== undefined && value !== null && value !== '') {
    throw new Error('workspace is only valid for workspace incidents');
  }
  return null;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  return positiveInteger(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} is invalid`);
  return parsed;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) throw new Error(`${field} is invalid`);
  return normalized;
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${field} is invalid`);
  return parsed.toISOString();
}

function assertStatusTransition(
  from: OperatorIncidentStatus,
  to: OperatorIncidentStatus,
): void {
  if (from === to) return;
  const allowed: Record<OperatorIncidentStatus, readonly OperatorIncidentStatus[]> = {
    investigating: ['identified', 'monitoring', 'resolved'],
    identified: ['investigating', 'monitoring', 'resolved'],
    monitoring: ['investigating', 'identified', 'resolved'],
    resolved: ['investigating'],
  };
  if (!allowed[from].includes(to)) throw new Error('incident status transition is invalid');
}
