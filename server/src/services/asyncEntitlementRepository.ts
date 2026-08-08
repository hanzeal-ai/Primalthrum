import {
  type AsyncDatabaseAdapter,
  type AsyncDatabaseSession,
} from '../db/asyncAdapter';
import { databaseTimestamp } from '../db/databaseTimestamp';
import {
  BillingError,
  type EntitlementRecord,
  type EntitlementSnapshot,
} from './billingTypes';
import {
  nonNegativeBillingInteger,
  normalizeBillingKey,
  normalizeBillingReference,
  normalizeBillingTimestamp,
} from './billingValidation';
import { type GrantEntitlementInput } from './entitlementStore';

interface EntitlementRow {
  feature_key: string;
  enabled: boolean | number;
  quantity_limit: number | null;
  source: string;
  priority: number;
}

interface SubscriptionRow {
  plan_key: string;
  state: string;
  trial_ends_at: string | Date | null;
}

const ACTIVE_SUBSCRIPTION_STATES = new Set([
  'trialing',
  'active',
  'past_due',
  'cancel_at_period_end',
]);

export class AsyncEntitlementRepository {
  constructor(
    private readonly database: AsyncDatabaseAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  snapshot(workspaceId: number): Promise<EntitlementSnapshot> {
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, workspaceId);
      await ensureBaseline(session, workspaceId);
      return this.snapshotWith(session, workspaceId);
    });
  }

  async assert(
    workspaceId: number,
    featureValue: string,
    currentUsage = 0,
    requestedQuantity = 1,
  ): Promise<EntitlementRecord> {
    const feature = normalizeBillingKey(featureValue, 'feature');
    const entitlement = (await this.snapshot(workspaceId)).entitlements[feature];
    if (!entitlement?.enabled) {
      throw new BillingError('ENTITLEMENT_REQUIRED', `feature ${feature} is not enabled`);
    }
    if (
      entitlement.quantityLimit !== null
      && currentUsage + requestedQuantity > entitlement.quantityLimit
    ) {
      throw new BillingError('ENTITLEMENT_LIMIT_EXCEEDED', `feature ${feature} limit exceeded`);
    }
    return entitlement;
  }

  grant(input: GrantEntitlementInput): Promise<EntitlementSnapshot> {
    const feature = normalizeBillingKey(input.feature, 'feature');
    const sourceType = normalizeBillingKey(input.sourceType, 'source type');
    const sourceRef = normalizeBillingReference(input.sourceRef, 'source reference');
    const priority = input.priority === undefined
      ? 100
      : nonNegativeBillingInteger(input.priority, 'grant priority');
    const quantityLimit = input.quantityLimit === undefined || input.quantityLimit === null
      ? null
      : nonNegativeBillingInteger(input.quantityLimit, 'quantity limit');
    const startsAt = normalizeBillingTimestamp(input.startsAt ?? this.now().toISOString(), 'startsAt');
    const endsAt = input.endsAt === undefined || input.endsAt === null
      ? null
      : normalizeBillingTimestamp(input.endsAt, 'endsAt');
    if (endsAt !== null && endsAt <= startsAt) throw new Error('endsAt must be later than startsAt');
    return this.database.transaction(async (session) => {
      await this.lockWorkspace(session, input.workspaceId);
      await ensureBaseline(session, input.workspaceId);
      await session.execute({
        text: `
          INSERT INTO entitlement_grants (
            workspace_id, feature_key, enabled, quantity_limit,
            source_type, source_ref, priority, starts_at, ends_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT(workspace_id, source_type, source_ref, feature_key) DO NOTHING;
        `,
        values: [
          input.workspaceId,
          feature,
          input.enabled,
          quantityLimit,
          sourceType,
          sourceRef,
          priority,
          startsAt,
          endsAt,
        ],
      });
      return this.snapshotWith(session, input.workspaceId);
    });
  }

  private async snapshotWith(
    session: AsyncDatabaseSession,
    workspaceId: number,
  ): Promise<EntitlementSnapshot> {
    const generatedAt = this.now().toISOString();
    await session.execute({
      text: `
        UPDATE workspace_subscriptions
        SET state = 'restricted', updated_at = CURRENT_TIMESTAMP
        WHERE workspace_id = $1 AND state = 'past_due'
          AND grace_ends_at IS NOT NULL AND grace_ends_at <= $2;
      `,
      values: [workspaceId, generatedAt],
    });
    const subscriptions = await session.query<SubscriptionRow>({
      text: `
        SELECT plan_key, state, trial_ends_at FROM workspace_subscriptions
        WHERE workspace_id = $1 LIMIT 1;
      `,
      values: [workspaceId],
    });
    const subscription = subscriptions[0];
    if (!subscription) throw new Error('workspace subscription could not be loaded');
    const trialEndsAt = subscription.trial_ends_at === null
      ? null
      : databaseTimestamp(subscription.trial_ends_at);
    const trialExpired = subscription.state === 'trialing'
      && trialEndsAt !== null
      && trialEndsAt <= generatedAt;
    const planKey = ACTIVE_SUBSCRIPTION_STATES.has(subscription.state) && !trialExpired
      ? subscription.plan_key
      : 'free';
    const rows = await session.query<EntitlementRow>({
      text: `
        SELECT feature_key, enabled, quantity_limit,
          'plan:' || plan_key AS source, 0 AS priority
        FROM plan_entitlements WHERE plan_key = $1
        UNION ALL
        SELECT feature_key, enabled, quantity_limit,
          source_type || ':' || source_ref AS source, priority
        FROM entitlement_grants
        WHERE workspace_id = $2 AND starts_at <= $3
          AND (ends_at IS NULL OR ends_at > $3)
        ORDER BY priority ASC;
      `,
      values: [planKey, workspaceId, generatedAt],
    });
    const entitlements: Record<string, EntitlementRecord> = {};
    for (const row of rows) {
      entitlements[row.feature_key] = {
        feature: row.feature_key,
        enabled: Boolean(row.enabled),
        quantityLimit: row.quantity_limit === null ? null : Number(row.quantity_limit),
        source: row.source,
      };
    }
    return {
      workspaceId,
      planKey,
      subscriptionState: trialExpired ? 'expired' : subscription.state,
      generatedAt,
      entitlements,
    };
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

async function ensureBaseline(
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
