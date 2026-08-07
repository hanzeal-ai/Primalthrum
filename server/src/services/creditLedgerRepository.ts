import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { ensureBillingWorkspaceBaseline } from './billingWorkspaceBaseline';
import {
  BillingError,
  type CreditAccountRecord,
  type CreditReservationRecord,
  type UsageEventRecord,
} from './billingTypes';
import {
  nonNegativeBillingInteger,
  normalizeBillingKey,
  normalizeBillingReference,
  positiveBillingInteger,
  parseBillingJson,
} from './billingValidation';

interface CreditAccountRow {
  workspace_id: number;
  available_credits: number;
  reserved_credits: number;
  spent_credits: number;
  updated_at: string;
}

interface ReservationRow {
  id: number;
  workspace_id: number;
  idempotency_key: string;
  meter: string;
  reserved_credits: number;
  settled_credits: number | null;
  state: CreditReservationRecord['state'];
  usage_event_id: number | null;
  created_at: string;
  settled_at: string | null;
  released_at: string | null;
}

interface UsageEventRow {
  id: number;
  workspace_id: number;
  reservation_id: number;
  idempotency_key: string;
  meter: string;
  quantity: number;
  credits_charged: number;
  resource_type: string;
  resource_id: string;
  metadata_json: string;
  occurred_at: string;
  created_at: string;
}

interface LedgerEntryRow {
  event_type: string;
  available_delta: number;
  usage_event_id: number | null;
}

export class CreditLedgerRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date,
  ) {}

  grant(input: {
    workspaceId: number;
    amount: number;
    idempotencyKey: string;
    sourceType: string;
    sourceRef: string;
  }): CreditAccountRecord {
    const amount = positiveBillingInteger(input.amount, 'credit amount');
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    ensureBillingWorkspaceBaseline(this.db, input.workspaceId);
    const existing = this.ledgerEntry(input.workspaceId, key);
    if (existing) {
      if (Number(existing.available_delta) !== amount || existing.event_type !== 'grant') {
        throw new BillingError('LEDGER_IDEMPOTENCY_CONFLICT', 'credit grant key was reused');
      }
      return this.account(input.workspaceId);
    }
    this.db.run(`
      INSERT INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        source_type, source_ref
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(key)}, 'grant', ${amount},
        ${sqlValue(normalizeBillingKey(input.sourceType, 'source type'))},
        ${sqlValue(normalizeBillingReference(input.sourceRef, 'source reference'))}
      );
    `);
    return this.account(input.workspaceId);
  }

  reserve(input: {
    workspaceId: number;
    idempotencyKey: string;
    meter: string;
    credits: number;
  }): CreditReservationRecord {
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    const meter = normalizeBillingKey(input.meter, 'meter');
    const credits = positiveBillingInteger(input.credits, 'reserved credits');
    ensureBillingWorkspaceBaseline(this.db, input.workspaceId);
    const existing = this.findReservation(input.workspaceId, key);
    if (existing) return validateReservation(existing, meter, credits);

    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO credit_reservations (
        workspace_id, idempotency_key, meter, reserved_credits
      )
      SELECT ${sqlValue(input.workspaceId)}, ${sqlValue(key)}, ${sqlValue(meter)}, ${credits}
      FROM credit_accounts
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND available_credits >= ${credits};

      INSERT OR IGNORE INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        reserved_delta, reservation_id, source_type, source_ref
      )
      SELECT workspace_id, ${sqlValue(`reserve:${key}`)}, 'reserve',
        -reserved_credits, reserved_credits, id, 'reservation', CAST(id AS TEXT)
      FROM credit_reservations
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND idempotency_key = ${sqlValue(key)};
      COMMIT;
    `);
    const reservation = this.findReservation(input.workspaceId, key);
    if (!reservation) throw new BillingError('CREDIT_LIMIT_EXCEEDED', 'insufficient available credits');
    return reservation;
  }

  settle(input: {
    workspaceId: number;
    reservationKey: string;
    usageIdempotencyKey: string;
    quantity: number;
    actualCredits: number;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): UsageEventRecord {
    const reservationKey = normalizeBillingKey(input.reservationKey, 'reservation key');
    const usageKey = normalizeBillingKey(input.usageIdempotencyKey, 'usage idempotency key');
    const quantity = nonNegativeBillingInteger(input.quantity, 'usage quantity');
    const actualCredits = nonNegativeBillingInteger(input.actualCredits, 'actual credits');
    const reservation = this.findReservation(input.workspaceId, reservationKey);
    if (!reservation) throw new BillingError('RESERVATION_NOT_FOUND', 'credit reservation not found');
    const existingUsage = this.findUsageByReservation(reservation.id);
    if (existingUsage) {
      if (
        existingUsage.idempotencyKey !== usageKey
        || existingUsage.quantity !== quantity
        || existingUsage.creditsCharged !== actualCredits
      ) {
        throw new BillingError('USAGE_IDEMPOTENCY_CONFLICT', 'usage settlement does not match');
      }
      return existingUsage;
    }
    if (reservation.state !== 'reserved') {
      throw new BillingError('RESERVATION_NOT_ACTIVE', 'credit reservation is not active');
    }
    const settleLedgerKey = `settle:${reservationKey}`;
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO usage_events (
        workspace_id, reservation_id, idempotency_key, meter, quantity,
        credits_charged, resource_type, resource_id, metadata_json, occurred_at
      )
      SELECT
        r.workspace_id, r.id, ${sqlValue(usageKey)}, r.meter, ${quantity},
        ${actualCredits}, ${sqlValue(input.resourceType ?? '')},
        ${sqlValue(input.resourceId ?? '')}, ${sqlValue(JSON.stringify(input.metadata ?? {}))},
        ${sqlValue(this.now().toISOString())}
      FROM credit_reservations r
      JOIN credit_accounts a ON a.workspace_id = r.workspace_id
      WHERE r.workspace_id = ${sqlValue(input.workspaceId)}
        AND r.idempotency_key = ${sqlValue(reservationKey)}
        AND r.state = 'reserved'
        AND a.available_credits + r.reserved_credits >= ${actualCredits};

      INSERT OR IGNORE INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        reserved_delta, spent_delta, reservation_id, usage_event_id,
        source_type, source_ref
      )
      SELECT
        r.workspace_id, ${sqlValue(settleLedgerKey)}, 'settle',
        r.reserved_credits - u.credits_charged, -r.reserved_credits,
        u.credits_charged, r.id, u.id, 'usage', CAST(u.id AS TEXT)
      FROM credit_reservations r
      JOIN usage_events u ON u.reservation_id = r.id
      WHERE r.workspace_id = ${sqlValue(input.workspaceId)}
        AND r.idempotency_key = ${sqlValue(reservationKey)}
        AND r.state = 'reserved';

      UPDATE credit_reservations
      SET state = 'settled', settled_credits = ${actualCredits},
          usage_event_id = (
            SELECT id FROM usage_events WHERE reservation_id = credit_reservations.id
          ),
          settled_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(input.workspaceId)}
        AND idempotency_key = ${sqlValue(reservationKey)}
        AND EXISTS (
          SELECT 1 FROM credit_ledger_entries
          WHERE workspace_id = ${sqlValue(input.workspaceId)}
            AND idempotency_key = ${sqlValue(settleLedgerKey)}
        );
      COMMIT;
    `);
    const usage = this.findUsageByReservation(reservation.id);
    if (!usage) throw new BillingError('CREDIT_LIMIT_EXCEEDED', 'settlement exceeds available credits');
    return usage;
  }

  release(workspaceId: number, reservationKeyValue: string): CreditReservationRecord {
    const reservationKey = normalizeBillingKey(reservationKeyValue, 'reservation key');
    const reservation = this.findReservation(workspaceId, reservationKey);
    if (!reservation) throw new BillingError('RESERVATION_NOT_FOUND', 'credit reservation not found');
    if (reservation.state === 'released') return reservation;
    if (reservation.state !== 'reserved') {
      throw new BillingError('RESERVATION_NOT_ACTIVE', 'settled reservations cannot be released');
    }
    const releaseLedgerKey = `release:${reservationKey}`;
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        reserved_delta, reservation_id, source_type, source_ref
      )
      SELECT workspace_id, ${sqlValue(releaseLedgerKey)}, 'release',
        reserved_credits, -reserved_credits, id, 'reservation', CAST(id AS TEXT)
      FROM credit_reservations
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(reservationKey)}
        AND state = 'reserved';

      UPDATE credit_reservations
      SET state = 'released', released_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(reservationKey)}
        AND state = 'reserved'
        AND EXISTS (
          SELECT 1 FROM credit_ledger_entries
          WHERE workspace_id = ${sqlValue(workspaceId)}
            AND idempotency_key = ${sqlValue(releaseLedgerKey)}
        );
      COMMIT;
    `);
    const released = this.findReservation(workspaceId, reservationKey);
    if (!released) throw new Error('released reservation could not be loaded');
    return released;
  }

  refund(input: {
    workspaceId: number;
    usageEventId: number;
    credits: number;
    idempotencyKey: string;
    sourceRef: string;
  }): CreditAccountRecord {
    const credits = positiveBillingInteger(input.credits, 'refund credits');
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    const existing = this.ledgerEntry(input.workspaceId, key);
    if (existing) {
      if (
        existing.event_type !== 'refund'
        || Number(existing.available_delta) !== credits
        || Number(existing.usage_event_id) !== input.usageEventId
      ) {
        throw new BillingError('LEDGER_IDEMPOTENCY_CONFLICT', 'refund key was reused');
      }
      return this.account(input.workspaceId);
    }
    this.db.run(`
      BEGIN IMMEDIATE;
      INSERT INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta,
        spent_delta, usage_event_id, source_type, source_ref
      )
      SELECT
        u.workspace_id, ${sqlValue(key)}, 'refund', ${credits}, -${credits},
        u.id, 'refund', ${sqlValue(normalizeBillingReference(input.sourceRef, 'source reference'))}
      FROM usage_events u
      WHERE u.id = ${sqlValue(input.usageEventId)}
        AND u.workspace_id = ${sqlValue(input.workspaceId)}
        AND ${credits} <= u.credits_charged - COALESCE((
          SELECT SUM(l.available_delta)
          FROM credit_ledger_entries l
          WHERE l.workspace_id = u.workspace_id
            AND l.usage_event_id = u.id AND l.event_type = 'refund'
        ), 0);
      COMMIT;
    `);
    if (!this.ledgerEntry(input.workspaceId, key)) {
      throw new BillingError('REFUND_LIMIT_EXCEEDED', 'refund exceeds charged credits');
    }
    return this.account(input.workspaceId);
  }

  account(workspaceId: number): CreditAccountRecord {
    ensureBillingWorkspaceBaseline(this.db, workspaceId);
    const row = this.db.query<CreditAccountRow>(`
      SELECT workspace_id, available_credits, reserved_credits, spent_credits, updated_at
      FROM credit_accounts
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0];
    if (!row) throw new Error('credit account could not be loaded');
    return {
      workspaceId: Number(row.workspace_id),
      availableCredits: Number(row.available_credits),
      reservedCredits: Number(row.reserved_credits),
      spentCredits: Number(row.spent_credits),
      updatedAt: row.updated_at,
    };
  }

  private findReservation(workspaceId: number, key: string): CreditReservationRecord | null {
    const row = this.db.query<ReservationRow>(`
      SELECT id, workspace_id, idempotency_key, meter, reserved_credits,
        settled_credits, state, usage_event_id, created_at, settled_at, released_at
      FROM credit_reservations
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(key)}
      LIMIT 1;
    `)[0];
    return row ? toReservation(row) : null;
  }

  private findUsageByReservation(reservationId: number): UsageEventRecord | null {
    const row = this.db.query<UsageEventRow>(`
      SELECT id, workspace_id, reservation_id, idempotency_key, meter,
        quantity, credits_charged, resource_type, resource_id,
        metadata_json, occurred_at, created_at
      FROM usage_events
      WHERE reservation_id = ${sqlValue(reservationId)}
      LIMIT 1;
    `)[0];
    return row ? toUsageEvent(row) : null;
  }

  private ledgerEntry(workspaceId: number, key: string): LedgerEntryRow | null {
    return this.db.query<LedgerEntryRow>(`
      SELECT event_type, available_delta, usage_event_id
      FROM credit_ledger_entries
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND idempotency_key = ${sqlValue(key)}
      LIMIT 1;
    `)[0] ?? null;
  }
}

function validateReservation(
  reservation: CreditReservationRecord,
  meter: string,
  credits: number,
): CreditReservationRecord {
  if (reservation.meter !== meter || reservation.reservedCredits !== credits) {
    throw new BillingError('RESERVATION_IDEMPOTENCY_CONFLICT', 'reservation key was reused');
  }
  return reservation;
}

function toReservation(row: ReservationRow): CreditReservationRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    idempotencyKey: row.idempotency_key,
    meter: row.meter,
    reservedCredits: Number(row.reserved_credits),
    settledCredits: row.settled_credits === null ? null : Number(row.settled_credits),
    state: row.state,
    usageEventId: row.usage_event_id === null ? null : Number(row.usage_event_id),
    createdAt: row.created_at,
    settledAt: row.settled_at,
    releasedAt: row.released_at,
  };
}

function toUsageEvent(row: UsageEventRow): UsageEventRecord {
  return {
    id: Number(row.id),
    workspaceId: Number(row.workspace_id),
    reservationId: Number(row.reservation_id),
    idempotencyKey: row.idempotency_key,
    meter: row.meter,
    quantity: Number(row.quantity),
    creditsCharged: Number(row.credits_charged),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: parseBillingJson(row.metadata_json),
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}
