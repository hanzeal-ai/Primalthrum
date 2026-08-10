import { randomUUID } from 'node:crypto';

import { type AsyncDatabaseAdapter, type AsyncDatabaseSession } from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
import {
  INCIDENT_EVENT_TYPES,
  INCIDENT_SCOPES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  type OperatorIncidentDetail,
  type OperatorIncidentEvent,
  type OperatorIncidentEventType,
  type OperatorIncidentScope,
  type OperatorIncidentSeverity,
  type OperatorIncidentStatus,
  type OperatorIncidentSummary,
} from './operatorIncidentRepository';
import { type OperatorIncidentStore } from './operatorIncidentStore';

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
  started_at: string | Date;
  resolved_at: string | Date | null;
  owner_operator_id: number | null;
  revision: number;
  event_count: number | string;
  created_by_operator_id: number;
  updated_by_operator_id: number;
  created_at: string | Date;
  updated_at: string | Date;
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
  created_at: string | Date;
}

export class AsyncOperatorIncidentRepository implements OperatorIncidentStore {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(limit = 100): Promise<OperatorIncidentSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = await this.database.query<IncidentRow>({
      text: `
        ${INCIDENT_SELECT}
        ORDER BY
          CASE incident.status WHEN 'resolved' THEN 1 ELSE 0 END,
          CASE incident.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2
            WHEN 'sev3' THEN 3 ELSE 4 END,
          incident.started_at DESC,
          incident.id DESC
        LIMIT $1;
      `,
      values: [boundedLimit],
    });
    return rows.map(toIncidentSummary);
  }

  async find(id: number): Promise<OperatorIncidentDetail | null> {
    return this.findIn(this.database, id);
  }

  create(input: Parameters<OperatorIncidentStore['create']>[0]): Promise<OperatorIncidentDetail> {
    const incidentRef = `INC-${randomUUID().slice(0, 8).toUpperCase()}`;
    const title = boundedText(input.title, 'incident title', 5, 160);
    const severity = incidentSeverity(input.severity);
    const impactScope = incidentScope(input.impactScope);
    const workspaceId = scopedWorkspace(impactScope, input.workspaceId);
    const summary = boundedText(input.summary, 'incident summary', 12, 2000);
    const startedAt = isoTimestamp(input.startedAt, 'incident start time');
    if (new Date(startedAt).valueOf() > this.now().valueOf()) {
      throw new Error('incident start time cannot be in the future');
    }
    const ownerOperatorId = optionalPositiveInteger(input.ownerOperatorId, 'incident owner');
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      if (workspaceId !== null) await this.requireWorkspace(session, workspaceId, true);
      if (ownerOperatorId !== null) await this.requireOperator(session, ownerOperatorId, true);
      const rows = await session.query<{ id: number }>({
        text: `
          INSERT INTO operator_incidents (
            incident_ref, title, severity, status, impact_scope, workspace_id,
            summary, started_at, owner_operator_id, created_by_operator_id,
            updated_by_operator_id, created_at, updated_at
          ) VALUES ($1, $2, $3, 'investigating', $4, $5, $6, $7, $8, $9, $9, $10, $10)
          RETURNING id;
        `,
        values: [
          incidentRef, title, severity, impactScope, workspaceId, summary,
          startedAt, ownerOperatorId, input.operatorUserId, now,
        ],
      });
      const id = Number(rows[0]?.id);
      await this.recordEvent(
        session,
        id,
        input.operatorUserId,
        'created',
        'Incident created',
        '',
        'investigating',
        now,
      );
      return this.requiredIncidentIn(session, id);
    });
  }

  update(
    id: number,
    input: Parameters<OperatorIncidentStore['update']>[1],
  ): Promise<OperatorIncidentDetail> {
    const expectedRevision = positiveInteger(input.expectedRevision, 'incident revision');
    const title = boundedText(input.title, 'incident title', 5, 160);
    const severity = incidentSeverity(input.severity);
    const status = incidentStatus(input.status);
    const impactScope = incidentScope(input.impactScope);
    const workspaceId = scopedWorkspace(impactScope, input.workspaceId);
    const summary = boundedText(input.summary, 'incident summary', 12, 2000);
    const ownerOperatorId = optionalPositiveInteger(input.ownerOperatorId, 'incident owner');
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      const existing = await this.requiredIncidentIn(session, id, true);
      if (existing.revision !== expectedRevision) throw new Error('incident revision conflict');
      assertStatusTransition(existing.status, status);
      if (workspaceId !== null) await this.requireWorkspace(session, workspaceId, true);
      if (ownerOperatorId !== null) await this.requireOperator(session, ownerOperatorId, true);
      const resolvedAt = status === 'resolved' ? existing.resolvedAt ?? now : null;
      const nextRevision = expectedRevision + 1;
      const result = await session.execute({
        text: `
          UPDATE operator_incidents
          SET title = $2, severity = $3, status = $4, impact_scope = $5,
            workspace_id = $6, summary = $7, resolved_at = $8,
            owner_operator_id = $9, revision = $10,
            updated_by_operator_id = $11, updated_at = $12
          WHERE id = $1 AND revision = $13;
        `,
        values: [
          id, title, severity, status, impactScope, workspaceId, summary,
          resolvedAt, ownerOperatorId, nextRevision, input.operatorUserId, now,
          expectedRevision,
        ],
      });
      if (result.rowCount !== 1) throw new Error('incident revision conflict');
      const eventType = status === existing.status ? 'updated' : 'status_changed';
      const message = status === existing.status
        ? 'Incident details updated'
        : `Status changed from ${existing.status} to ${status}`;
      await this.recordEvent(
        session,
        id,
        input.operatorUserId,
        eventType,
        message,
        existing.status,
        status,
        now,
      );
      return this.requiredIncidentIn(session, id);
    });
  }

  appendEvent(
    id: number,
    input: Parameters<OperatorIncidentStore['appendEvent']>[1],
  ): Promise<OperatorIncidentEvent> {
    const eventType = incidentEventType(input.eventType);
    const message = boundedText(input.message, 'incident event message', 3, 2000);
    const now = this.now().toISOString();
    return this.database.transaction(async (session) => {
      await this.requiredIncidentIn(session, id, true);
      const eventId = await this.recordEvent(
        session,
        id,
        input.operatorUserId,
        eventType,
        message,
        '',
        '',
        now,
      );
      const rows = await session.query<IncidentEventRow>({
        text: `SELECT ${EVENT_COLUMNS} FROM operator_incident_events WHERE event_id = $1 LIMIT 1;`,
        values: [eventId],
      });
      if (!rows[0]) throw new Error('incident event could not be created');
      return toIncidentEvent(rows[0]);
    });
  }

  private async findIn(
    session: AsyncDatabaseSession,
    id: number,
    lock = false,
  ): Promise<OperatorIncidentDetail | null> {
    const rows = await session.query<IncidentRow>({
      text: `
        ${INCIDENT_SELECT}
        WHERE incident.id = $1 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE OF incident' : ''};
      `,
      values: [id],
    });
    if (!rows[0]) return null;
    const events = await session.query<IncidentEventRow>({
      text: `
        SELECT ${EVENT_COLUMNS} FROM operator_incident_events
        WHERE incident_id = $1 ORDER BY id ASC;
      `,
      values: [id],
    });
    return { ...toIncidentSummary(rows[0]), events: events.map(toIncidentEvent) };
  }

  private async requiredIncidentIn(
    session: AsyncDatabaseSession,
    id: number,
    lock = false,
  ): Promise<OperatorIncidentDetail> {
    const incident = await this.findIn(session, id, lock);
    if (!incident) throw new Error('incident not found');
    return incident;
  }

  private async requireWorkspace(
    session: AsyncDatabaseSession,
    id: number,
    lock: boolean,
  ): Promise<void> {
    const rows = await session.query<{ id: number }>({
      text: `
        SELECT id FROM workspaces WHERE id = $1 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [id],
    });
    if (!rows[0]) throw new Error('workspace not found');
  }

  private async requireOperator(
    session: AsyncDatabaseSession,
    id: number,
    lock: boolean,
  ): Promise<void> {
    const rows = await session.query<{ id: number }>({
      text: `
        SELECT id FROM operator_users WHERE id = $1 AND status = $2 LIMIT 1
        ${lock && this.database.dialect === 'postgres' ? 'FOR UPDATE' : ''};
      `,
      values: [id, 'active'],
    });
    if (!rows[0]) throw new Error('incident owner not found');
  }

  private async recordEvent(
    session: AsyncDatabaseSession,
    incidentId: number,
    operatorUserId: number,
    eventType: OperatorIncidentEvent['eventType'],
    message: string,
    fromStatus: string,
    toStatus: string,
    now: string,
  ): Promise<string> {
    const eventId = randomUUID();
    await session.execute({
      text: `
        INSERT INTO operator_incident_events (
          event_id, incident_id, operator_user_id, event_type, message,
          from_status, to_status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `,
      values: [eventId, incidentId, operatorUserId, eventType, message, fromStatus, toStatus, now],
    });
    return eventId;
  }
}

const INCIDENT_SELECT = `
  SELECT incident.*, workspace.name AS workspace_name,
    (SELECT COUNT(*) FROM operator_incident_events event
      WHERE event.incident_id = incident.id) AS event_count
  FROM operator_incidents incident
  LEFT JOIN workspaces workspace ON workspace.id = incident.workspace_id
`;

const EVENT_COLUMNS = [
  'id', 'event_id', 'incident_id', 'operator_user_id', 'event_type',
  'message', 'from_status', 'to_status', 'created_at',
].join(', ');

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
    startedAt: databaseTimestamp(row.started_at),
    resolvedAt: nullableDatabaseTimestamp(row.resolved_at),
    ownerOperatorId: row.owner_operator_id === null ? null : Number(row.owner_operator_id),
    revision: Number(row.revision),
    eventCount: Number(row.event_count),
    createdByOperatorId: Number(row.created_by_operator_id),
    updatedByOperatorId: Number(row.updated_by_operator_id),
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
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
    createdAt: databaseTimestamp(row.created_at),
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
