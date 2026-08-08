import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import { type OperatorAbuseEventSummary } from './operatorSecurityReadRepository';
import { type OperatorSecurityReadStore } from './operatorSecurityReadStore';

interface AbuseEventRow {
  id: number;
  event_id: string;
  rule_key: string;
  action: string;
  outcome: string;
  retry_after_seconds: number;
  created_at: string | Date;
}

export class AsyncOperatorSecurityReadRepository implements OperatorSecurityReadStore {
  constructor(private readonly database: AsyncDatabaseAdapter) {}

  async listAbuseEvents(limit = 100): Promise<OperatorAbuseEventSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
    const rows = await this.database.query<AbuseEventRow>({
      text: `
        SELECT id, event_id, rule_key, action, outcome, retry_after_seconds, created_at
        FROM abuse_enforcement_events ORDER BY created_at DESC, id DESC LIMIT $1;
      `,
      values: [boundedLimit],
    });
    return rows.map((row) => ({
      id: Number(row.id),
      eventId: row.event_id,
      ruleKey: row.rule_key,
      action: row.action,
      outcome: row.outcome,
      retryAfterSeconds: Number(row.retry_after_seconds),
      createdAt: databaseTimestamp(row.created_at),
    }));
  }
}
