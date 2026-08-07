import { type AsyncDatabaseAdapter } from '../db/asyncAdapter';

export const POSTGRES_COMMERCIAL_TABLES = [
  'billing_invoices',
  'billing_plans',
  'billing_refunds',
  'cost_alerts',
  'credit_accounts',
  'credit_ledger_entries',
  'credit_reservations',
  'entitlement_grants',
  'meter_prices',
  'payment_checkout_sessions',
  'payment_customers',
  'payment_prices',
  'payment_webhook_events',
  'plan_entitlements',
  'pricing_versions',
  'rated_usage_events',
  'subscription_state_events',
  'trial_grants',
  'usage_events',
  'usage_meter_exports',
  'workspace_cost_controls',
  'workspace_subscriptions',
] as const;

async function expectDatabaseFailure(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error(message);
}

async function meterPriceId(database: AsyncDatabaseAdapter): Promise<number> {
  const prices = await database.query<{ id: number }>({
    text: `
      SELECT id
      FROM meter_prices
      WHERE pricing_version_key = $1 AND meter = $2 AND provider = '*' AND model = '*';
    `,
    values: ['2026-08-default', 'hosted.runs'],
  });
  if (!prices[0]?.id) throw new Error('default hosted run price was not migrated');
  return prices[0].id;
}

export async function seedRatedUsageBeforeOutbox(database: AsyncDatabaseAdapter): Promise<number> {
  const priceId = await meterPriceId(database);
  const rows = await database.query<{ id: number }>({
    text: `
      INSERT INTO rated_usage_events (
        workspace_id, idempotency_key, meter, quantity, billable_units,
        credits_charged, provider_cost_micros, meter_price_id, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      RETURNING id;
    `,
    values: [1, 'migration-rated-before-outbox', 'hosted.runs', 1, 1, 10, 0, priceId],
  });
  if (!rows[0]?.id) throw new Error('rated usage seed failed');
  return rows[0].id;
}

export async function verifyCommercialMigrations(
  database: AsyncDatabaseAdapter,
  userId: number,
  preOutboxRatedUsageId: number,
): Promise<void> {
  const planCount = await database.query<{ count: number }>({
    text: 'SELECT COUNT(*)::integer AS count FROM billing_plans;',
  });
  if (Number(planCount[0]?.count) !== 5) throw new Error('commercial plan catalog was not migrated');
  const priceCount = await database.query<{ count: number }>({
    text: 'SELECT COUNT(*)::integer AS count FROM meter_prices;',
  });
  if (Number(priceCount[0]?.count) !== 11) throw new Error('meter price catalog was not migrated');

  await database.execute({
    text: `
      INSERT INTO credit_ledger_entries (
        workspace_id, idempotency_key, event_type, available_delta, source_type, source_ref
      ) VALUES ($1, $2, $3, $4, $5, $6);
    `,
    values: [1, 'migration-credit-grant', 'grant', 100, 'smoke', 'migration'],
  });
  const credits = await database.query<{ available_credits: number }>({
    text: 'SELECT available_credits FROM credit_accounts WHERE workspace_id = $1;',
    values: [1],
  });
  if (Number(credits[0]?.available_credits) !== 100) {
    throw new Error('credit ledger trigger did not update the account');
  }
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE credit_ledger_entries SET available_delta = $1 WHERE idempotency_key = $2;',
      values: [101, 'migration-credit-grant'],
    }),
    'credit ledger update was not rejected',
  );
  await expectDatabaseFailure(
    () => database.execute({
      text: `
        INSERT INTO credit_ledger_entries (
          workspace_id, idempotency_key, event_type, available_delta, source_type, source_ref
        ) VALUES ($1, $2, $3, $4, $5, $6);
      `,
      values: [1, 'migration-credit-underflow', 'adjustment', -101, 'smoke', 'underflow'],
    }),
    'credit account underflow was not rejected',
  );

  const backfilledExports = await database.query<{ count: number }>({
    text: `
      SELECT COUNT(*)::integer AS count
      FROM usage_meter_exports
      WHERE rated_usage_event_id = $1 AND destination = 'primary';
    `,
    values: [preOutboxRatedUsageId],
  });
  if (Number(backfilledExports[0]?.count) !== 1) {
    throw new Error('preexisting rated usage was not backfilled into the export outbox');
  }

  const priceId = await meterPriceId(database);
  const afterRows = await database.query<{ id: number }>({
    text: `
      INSERT INTO rated_usage_events (
        workspace_id, idempotency_key, meter, quantity, billable_units,
        credits_charged, provider_cost_micros, meter_price_id, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      RETURNING id;
    `,
    values: [1, 'migration-rated-after-outbox', 'hosted.runs', 1, 1, 10, 0, priceId],
  });
  const triggeredExports = await database.query<{ count: number }>({
    text: 'SELECT COUNT(*)::integer AS count FROM usage_meter_exports WHERE rated_usage_event_id = $1;',
    values: [afterRows[0]!.id],
  });
  if (Number(triggeredExports[0]?.count) !== 1) {
    throw new Error('rated usage export trigger did not enqueue an outbox row');
  }
  await expectDatabaseFailure(
    () => database.execute({
      text: 'UPDATE rated_usage_events SET quantity = $1 WHERE id = $2;',
      values: [2, afterRows[0]!.id],
    }),
    'rated usage update was not rejected',
  );

  await database.execute({
    text: `
      INSERT INTO payment_prices (provider, plan_key, provider_price_ref)
      VALUES ($1, $2, $3);
    `,
    values: ['stripe', 'pro', 'price_migration_smoke'],
  });
  await database.execute({
    text: `
      INSERT INTO payment_customers (workspace_id, provider, provider_customer_ref, email)
      VALUES ($1, $2, $3, $4);
    `,
    values: [1, 'stripe', 'cus_migration_smoke', 'billing-smoke@example.com'],
  });
  await database.execute({
    text: `
      INSERT INTO payment_checkout_sessions (
        workspace_id, provider, idempotency_key, provider_session_ref,
        plan_key, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6);
    `,
    values: [1, 'stripe', 'checkout-migration-smoke', 'cs_migration_smoke', 'pro', userId],
  });
  const checkout = await database.query<{ status: string }>({
    text: 'SELECT status FROM payment_checkout_sessions WHERE provider_session_ref = $1;',
    values: ['cs_migration_smoke'],
  });
  if (checkout[0]?.status !== 'open') throw new Error('payment lifecycle schema is not writable');
}
