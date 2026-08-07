import { type DatabaseAdapter } from '../db/adapter';

export interface OperatorAbuseEventSummary {
  id: number;
  eventId: string;
  ruleKey: string;
  action: string;
  outcome: string;
  retryAfterSeconds: number;
  createdAt: string;
}

interface AbuseEventRow {
  id: number;
  event_id: string;
  rule_key: string;
  action: string;
  outcome: string;
  retry_after_seconds: number;
  created_at: string;
}

export class OperatorSecurityReadRepository {
  constructor(private readonly db: DatabaseAdapter) {
  }

  listAbuseEvents(limit = 100): OperatorAbuseEventSummary[] {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    return this.db.query<AbuseEventRow>(`
      SELECT id, event_id, rule_key, action, outcome, retry_after_seconds, created_at
      FROM abuse_enforcement_events
      ORDER BY created_at DESC, id DESC
      LIMIT ${boundedLimit};
    `).map((row) => ({
      id: Number(row.id),
      eventId: row.event_id,
      ruleKey: row.rule_key,
      action: row.action,
      outcome: row.outcome,
      retryAfterSeconds: Number(row.retry_after_seconds),
      createdAt: row.created_at,
    }));
  }
}
