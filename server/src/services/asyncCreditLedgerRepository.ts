import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp, nullableDatabaseTimestamp } from '../db/databaseTimestamp';
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
  parseBillingJson,
  positiveBillingInteger,
} from './billingValidation';
import {
  type GrantCreditsInput,
  type RefundCreditsInput,
  type ReserveCreditsInput,
  type SettleCreditsInput,
} from './creditLedgerStore';

interface CreditAccountRow {
  workspace_id: number;
  available_credits: number;
  reserved_credits: number;
  spent_credits: number;
  updated_at: string | Date;
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
  created_at: string | Date;
  settled_at: string | Date | null;
  released_at: string | Date | null;
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
  occurred_at: string | Date;
  created_at: string | Date;
}

interface LedgerEntryRow {
  event_type: string;
  available_delta: number;
  usage_event_id: number | null;
}

const RESERVATION_COLUMNS = [
  'id', 'workspace_id', 'idempotency_key', 'meter', 'reserved_credits',
  'settled_credits', 'state', 'usage_event_id', 'created_at', 'settled_at',
  'released_at',
].join(', ');

const USAGE_COLUMNS = [
  'id', 'workspace_id', 'reservation_id', 'idempotency_key', 'meter',
  'quantity', 'credits_charged', 'resource_type', 'resource_id',
  'metadata_json', 'occurred_at', 'created_at',
].join(', ');

export class AsyncCreditLedgerRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  grant(input: GrantCreditsInput): Promise<CreditAccountRecord> {
    const amount = positiveBillingInteger(input.amount, 'credit amount');
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    const sourceType = normalizeBillingKey(input.sourceType, 'source type');
    const sourceRef = normalizeBillingReference(input.sourceRef, 'source reference');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      await this.ensureBaseline(session, input.workspaceId);
      const existing = await this.ledgerEntry(session, input.workspaceId, key);
      if (existing) {
        validateGrantReplay(existing, amount);
        return this.accountWith(session, input.workspaceId);
      }
      await session.execute({
        text: `
          INSERT INTO credit_ledger_entries (
            workspace_id, idempotency_key, event_type, available_delta,
            source_type, source_ref
          ) VALUES ($1, $2, 'grant', $3, $4, $5);
        `,
        values: [input.workspaceId, key, amount, sourceType, sourceRef],
      });
      return this.accountWith(session, input.workspaceId);
    });
  }

  reserve(input: ReserveCreditsInput): Promise<CreditReservationRecord> {
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    const meter = normalizeBillingKey(input.meter, 'meter');
    const credits = positiveBillingInteger(input.credits, 'reserved credits');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      await this.ensureBaseline(session, input.workspaceId);
      const existing = await this.findReservation(session, input.workspaceId, key);
      if (existing) return validateReservation(existing, meter, credits);
      const account = await this.accountWith(session, input.workspaceId);
      if (account.availableCredits < credits) {
        throw new BillingError('CREDIT_LIMIT_EXCEEDED', 'insufficient available credits');
      }
      const rows = await session.query<ReservationRow>({
        text: `
          INSERT INTO credit_reservations (
            workspace_id, idempotency_key, meter, reserved_credits
          ) VALUES ($1, $2, $3, $4)
          RETURNING ${RESERVATION_COLUMNS};
        `,
        values: [input.workspaceId, key, meter, credits],
      });
      const reservation = rows[0];
      if (!reservation) throw new Error('credit reservation could not be loaded');
      await session.execute({
        text: `
          INSERT INTO credit_ledger_entries (
            workspace_id, idempotency_key, event_type, available_delta,
            reserved_delta, reservation_id, source_type, source_ref
          ) VALUES ($1, $2, 'reserve', $3, $4, $5, 'reservation', $6);
        `,
        values: [
          input.workspaceId,
          `reserve:${key}`,
          -credits,
          credits,
          reservation.id,
          String(reservation.id),
        ],
      });
      return toReservation(reservation);
    });
  }

  settle(input: SettleCreditsInput): Promise<UsageEventRecord> {
    const reservationKey = normalizeBillingKey(input.reservationKey, 'reservation key');
    const usageKey = normalizeBillingKey(input.usageIdempotencyKey, 'usage idempotency key');
    const quantity = nonNegativeBillingInteger(input.quantity, 'usage quantity');
    const actualCredits = nonNegativeBillingInteger(input.actualCredits, 'actual credits');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      const reservation = await this.findReservation(session, input.workspaceId, reservationKey);
      if (!reservation) {
        throw new BillingError('RESERVATION_NOT_FOUND', 'credit reservation not found');
      }
      const existingUsage = await this.findUsageByReservation(session, reservation.id);
      if (existingUsage) {
        return validateUsageReplay(existingUsage, usageKey, quantity, actualCredits);
      }
      if (reservation.state !== 'reserved') {
        throw new BillingError('RESERVATION_NOT_ACTIVE', 'credit reservation is not active');
      }
      const account = await this.accountWith(session, input.workspaceId);
      if (account.availableCredits + reservation.reservedCredits < actualCredits) {
        throw new BillingError('CREDIT_LIMIT_EXCEEDED', 'settlement exceeds available credits');
      }
      const usageRows = await session.query<UsageEventRow>({
        text: `
          INSERT INTO usage_events (
            workspace_id, reservation_id, idempotency_key, meter, quantity,
            credits_charged, resource_type, resource_id, metadata_json, occurred_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING ${USAGE_COLUMNS};
        `,
        values: [
          input.workspaceId,
          reservation.id,
          usageKey,
          reservation.meter,
          quantity,
          actualCredits,
          input.resourceType ?? '',
          input.resourceId ?? '',
          JSON.stringify(input.metadata ?? {}),
          this.now().toISOString(),
        ],
      });
      const usage = usageRows[0];
      if (!usage) throw new Error('usage event could not be loaded');
      await session.execute({
        text: `
          INSERT INTO credit_ledger_entries (
            workspace_id, idempotency_key, event_type, available_delta,
            reserved_delta, spent_delta, reservation_id, usage_event_id,
            source_type, source_ref
          ) VALUES ($1, $2, 'settle', $3, $4, $5, $6, $7, 'usage', $8);
        `,
        values: [
          input.workspaceId,
          `settle:${reservationKey}`,
          reservation.reservedCredits - actualCredits,
          -reservation.reservedCredits,
          actualCredits,
          reservation.id,
          usage.id,
          String(usage.id),
        ],
      });
      const updated = await session.execute({
        text: `
          UPDATE credit_reservations
          SET state = 'settled', settled_credits = $3, usage_event_id = $4,
            settled_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND idempotency_key = $2 AND state = 'reserved';
        `,
        values: [input.workspaceId, reservationKey, actualCredits, usage.id],
      });
      if (updated.rowCount !== 1) throw new Error('credit reservation settlement was not applied');
      return toUsageEvent(usage);
    });
  }

  release(workspaceId: number, reservationKeyValue: string): Promise<CreditReservationRecord> {
    const reservationKey = normalizeBillingKey(reservationKeyValue, 'reservation key');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      const reservation = await this.findReservation(session, workspaceId, reservationKey);
      if (!reservation) {
        throw new BillingError('RESERVATION_NOT_FOUND', 'credit reservation not found');
      }
      if (reservation.state === 'released') return reservation;
      if (reservation.state !== 'reserved') {
        throw new BillingError('RESERVATION_NOT_ACTIVE', 'settled reservations cannot be released');
      }
      await session.execute({
        text: `
          INSERT INTO credit_ledger_entries (
            workspace_id, idempotency_key, event_type, available_delta,
            reserved_delta, reservation_id, source_type, source_ref
          ) VALUES ($1, $2, 'release', $3, $4, $5, 'reservation', $6);
        `,
        values: [
          workspaceId,
          `release:${reservationKey}`,
          reservation.reservedCredits,
          -reservation.reservedCredits,
          reservation.id,
          String(reservation.id),
        ],
      });
      const rows = await session.query<ReservationRow>({
        text: `
          UPDATE credit_reservations
          SET state = 'released', released_at = CURRENT_TIMESTAMP
          WHERE workspace_id = $1 AND idempotency_key = $2 AND state = 'reserved'
          RETURNING ${RESERVATION_COLUMNS};
        `,
        values: [workspaceId, reservationKey],
      });
      if (!rows[0]) throw new Error('credit reservation release was not applied');
      return toReservation(rows[0]);
    });
  }

  refund(input: RefundCreditsInput): Promise<CreditAccountRecord> {
    const credits = positiveBillingInteger(input.credits, 'refund credits');
    const key = normalizeBillingKey(input.idempotencyKey, 'idempotency key');
    const sourceRef = normalizeBillingReference(input.sourceRef, 'source reference');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      const existing = await this.ledgerEntry(session, input.workspaceId, key);
      if (existing) {
        validateRefundReplay(existing, credits, input.usageEventId);
        return this.accountWith(session, input.workspaceId);
      }
      const rows = await session.query<{ credits_charged: number; refunded: number | string }>({
        text: `
          SELECT u.credits_charged, COALESCE(SUM(l.available_delta), 0) AS refunded
          FROM usage_events u
          LEFT JOIN credit_ledger_entries l
            ON l.workspace_id = u.workspace_id
            AND l.usage_event_id = u.id AND l.event_type = 'refund'
          WHERE u.id = $1 AND u.workspace_id = $2
          GROUP BY u.id, u.credits_charged;
        `,
        values: [input.usageEventId, input.workspaceId],
      });
      const usage = rows[0];
      if (!usage || credits > Number(usage.credits_charged) - Number(usage.refunded)) {
        throw new BillingError('REFUND_LIMIT_EXCEEDED', 'refund exceeds charged credits');
      }
      await session.execute({
        text: `
          INSERT INTO credit_ledger_entries (
            workspace_id, idempotency_key, event_type, available_delta,
            spent_delta, usage_event_id, source_type, source_ref
          ) VALUES ($1, $2, 'refund', $3, $4, $5, 'refund', $6);
        `,
        values: [input.workspaceId, key, credits, -credits, input.usageEventId, sourceRef],
      });
      return this.accountWith(session, input.workspaceId);
    });
  }

  account(workspaceId: number): Promise<CreditAccountRecord> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      await this.ensureBaseline(session, workspaceId);
      return this.accountWith(session, workspaceId);
    });
  }

  private async ensureBaseline(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<void> {
    await session.execute({
      text: `
        INSERT INTO workspace_subscriptions (
          workspace_id, plan_key, state, period_starts_at
        ) VALUES ($1, 'free', 'active', CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id) DO NOTHING;
      `,
      values: [workspaceId],
    });
    await session.execute({
      text: `
        INSERT INTO credit_accounts (workspace_id) VALUES ($1)
        ON CONFLICT(workspace_id) DO NOTHING;
      `,
      values: [workspaceId],
    });
    await session.execute({
      text: `
        INSERT INTO credit_ledger_entries (
          workspace_id, idempotency_key, event_type, available_delta,
          source_type, source_ref
        )
        SELECT $1, $2, 'grant', monthly_credit_grant, 'plan', 'free:initial'
        FROM billing_plans WHERE key = 'free'
        ON CONFLICT(workspace_id, idempotency_key) DO NOTHING;
      `,
      values: [workspaceId, `plan-period:free:${workspaceId}:initial`],
    });
  }

  private async accountWith(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<CreditAccountRecord> {
    const rows = await session.query<CreditAccountRow>({
      text: `
        SELECT workspace_id, available_credits, reserved_credits, spent_credits, updated_at
        FROM credit_accounts WHERE workspace_id = $1 LIMIT 1;
      `,
      values: [workspaceId],
    });
    if (!rows[0]) throw new Error('credit account could not be loaded');
    return toAccount(rows[0]);
  }

  private async findReservation(
    session: AsyncDatabaseSession,
    workspaceId: number,
    key: string,
  ): Promise<CreditReservationRecord | null> {
    const rows = await session.query<ReservationRow>({
      text: `
        SELECT ${RESERVATION_COLUMNS} FROM credit_reservations
        WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1;
      `,
      values: [workspaceId, key],
    });
    return rows[0] ? toReservation(rows[0]) : null;
  }

  private async findUsageByReservation(
    session: AsyncDatabaseSession,
    reservationId: number,
  ): Promise<UsageEventRecord | null> {
    const rows = await session.query<UsageEventRow>({
      text: `SELECT ${USAGE_COLUMNS} FROM usage_events WHERE reservation_id = $1 LIMIT 1;`,
      values: [reservationId],
    });
    return rows[0] ? toUsageEvent(rows[0]) : null;
  }

  private async ledgerEntry(
    session: AsyncDatabaseSession,
    workspaceId: number,
    key: string,
  ): Promise<LedgerEntryRow | null> {
    const rows = await session.query<LedgerEntryRow>({
      text: `
        SELECT event_type, available_delta, usage_event_id
        FROM credit_ledger_entries
        WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1;
      `,
      values: [workspaceId, key],
    });
    return rows[0] ?? null;
  }

  private async lockWorkspace(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<void> {
    if (this.database.dialect !== 'postgres') return;
    await session.query({
      text: 'SELECT pg_advisory_xact_lock($1);',
      values: [workspaceId],
    });
  }
}

function toAccount(row: CreditAccountRow): CreditAccountRecord {
  return {
    workspaceId: Number(row.workspace_id),
    availableCredits: Number(row.available_credits),
    reservedCredits: Number(row.reserved_credits),
    spentCredits: Number(row.spent_credits),
    updatedAt: databaseTimestamp(row.updated_at),
  };
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
    createdAt: databaseTimestamp(row.created_at),
    settledAt: nullableDatabaseTimestamp(row.settled_at),
    releasedAt: nullableDatabaseTimestamp(row.released_at),
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
    occurredAt: databaseTimestamp(row.occurred_at),
    createdAt: databaseTimestamp(row.created_at),
  };
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

function validateUsageReplay(
  usage: UsageEventRecord,
  key: string,
  quantity: number,
  credits: number,
): UsageEventRecord {
  if (
    usage.idempotencyKey !== key
    || usage.quantity !== quantity
    || usage.creditsCharged !== credits
  ) {
    throw new BillingError('USAGE_IDEMPOTENCY_CONFLICT', 'usage settlement does not match');
  }
  return usage;
}

function validateGrantReplay(entry: LedgerEntryRow, amount: number): void {
  if (entry.event_type !== 'grant' || Number(entry.available_delta) !== amount) {
    throw new BillingError('LEDGER_IDEMPOTENCY_CONFLICT', 'credit grant key was reused');
  }
}

function validateRefundReplay(
  entry: LedgerEntryRow,
  credits: number,
  usageEventId: number,
): void {
  if (
    entry.event_type !== 'refund'
    || Number(entry.available_delta) !== credits
    || Number(entry.usage_event_id) !== usageEventId
  ) {
    throw new BillingError('LEDGER_IDEMPOTENCY_CONFLICT', 'refund key was reused');
  }
}
