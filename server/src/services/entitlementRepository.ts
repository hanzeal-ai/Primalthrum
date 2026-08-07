import { type DatabaseAdapter } from '../db/adapter';
import { sqlValue } from '../db/sql';
import { ensureBillingWorkspaceBaseline } from './billingWorkspaceBaseline';
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

interface EntitlementRow {
  feature_key: string;
  enabled: number;
  quantity_limit: number | null;
  source: string;
  priority: number;
}

interface SubscriptionRow {
  plan_key: string;
  state: string;
  trial_ends_at: string | null;
}

const ACTIVE_SUBSCRIPTION_STATES = new Set([
  'trialing',
  'active',
  'past_due',
  'cancel_at_period_end',
]);

export class EntitlementRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly now: () => Date,
  ) {}

  snapshot(workspaceId: number): EntitlementSnapshot {
    ensureBillingWorkspaceBaseline(this.db, workspaceId);
    const generatedAt = this.now().toISOString();
    this.db.run(`
      UPDATE workspace_subscriptions
      SET state = 'restricted', updated_at = CURRENT_TIMESTAMP
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND state = 'past_due'
        AND grace_ends_at IS NOT NULL
        AND grace_ends_at <= ${sqlValue(generatedAt)};
    `);
    const subscription = this.db.query<SubscriptionRow>(`
      SELECT plan_key, state, trial_ends_at
      FROM workspace_subscriptions
      WHERE workspace_id = ${sqlValue(workspaceId)}
      LIMIT 1;
    `)[0];
    if (!subscription) throw new Error('workspace subscription could not be loaded');

    const trialExpired = subscription.state === 'trialing'
      && Boolean(subscription.trial_ends_at)
      && String(subscription.trial_ends_at) <= generatedAt;
    const planKey = ACTIVE_SUBSCRIPTION_STATES.has(subscription.state) && !trialExpired
      ? subscription.plan_key
      : 'free';
    const rows = this.db.query<EntitlementRow>(`
      SELECT feature_key, enabled, quantity_limit,
        'plan:' || plan_key AS source, 0 AS priority
      FROM plan_entitlements
      WHERE plan_key = ${sqlValue(planKey)}
      UNION ALL
      SELECT feature_key, enabled, quantity_limit,
        source_type || ':' || source_ref AS source, priority
      FROM entitlement_grants
      WHERE workspace_id = ${sqlValue(workspaceId)}
        AND starts_at <= ${sqlValue(generatedAt)}
        AND (ends_at IS NULL OR ends_at > ${sqlValue(generatedAt)})
      ORDER BY priority ASC;
    `);
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

  assert(
    workspaceId: number,
    featureValue: string,
    currentUsage = 0,
    requestedQuantity = 1,
  ): EntitlementRecord {
    const feature = normalizeBillingKey(featureValue, 'feature');
    const entitlement = this.snapshot(workspaceId).entitlements[feature];
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

  grant(input: {
    workspaceId: number;
    feature: string;
    enabled: boolean;
    quantityLimit?: number | null;
    sourceType: string;
    sourceRef: string;
    priority?: number;
    startsAt?: string;
    endsAt?: string | null;
  }): EntitlementSnapshot {
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
    ensureBillingWorkspaceBaseline(this.db, input.workspaceId);
    this.db.run(`
      INSERT INTO entitlement_grants (
        workspace_id, feature_key, enabled, quantity_limit,
        source_type, source_ref, priority, starts_at, ends_at
      ) VALUES (
        ${sqlValue(input.workspaceId)}, ${sqlValue(feature)}, ${input.enabled ? 1 : 0},
        ${sqlValue(quantityLimit)}, ${sqlValue(sourceType)}, ${sqlValue(sourceRef)},
        ${priority}, ${sqlValue(startsAt)}, ${sqlValue(endsAt)}
      )
      ON CONFLICT(workspace_id, source_type, source_ref, feature_key) DO NOTHING;
    `);
    return this.snapshot(input.workspaceId);
  }
}
