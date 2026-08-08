import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncOperatorBillingReadRepository } from '../services/asyncOperatorBillingReadRepository';
import { AsyncOperatorReadRepository } from '../services/asyncOperatorReadRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { hashPassword } from '../services/passwordHash';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 8 });
  try {
    await runPostgresMigrations(database);
    const suffix = Date.now();
    const owner = await new AsyncUserRepository(database).createUser(
      `operator-billing-${suffix}@example.com`,
      hashPassword('correct horse battery staple'),
      true,
    );
    const workspace = await new AsyncWorkspaceRepository(database).create(
      owner.id,
      `Operator Billing ${suffix}`,
    );
    await database.execute({
      text: `
        INSERT INTO workspace_subscriptions (
          workspace_id, plan_key, state, provider, period_starts_at, period_ends_at
        ) VALUES ($1, 'pro', 'active', 'stripe', $2, $3);
      `,
      values: [workspace.id, '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
    });
    const prices = await database.query<{ id: number }>({
      text: 'SELECT id FROM meter_prices ORDER BY id LIMIT 1;',
    });
    if (!prices[0]) throw new Error('PostgreSQL meter price seed is missing');
    await database.execute({
      text: `
        INSERT INTO rated_usage_events (
          workspace_id, idempotency_key, meter, quantity, billable_units,
          credits_charged, provider_cost_micros, meter_price_id, occurred_at
        ) VALUES ($1, $2, 'tokens', 250, 250, 25, 1200, $3, $4);
      `,
      values: [workspace.id, `operator-billing-${suffix}`, prices[0].id, '2026-08-08T12:00:00.000Z'],
    });
    await database.execute({
      text: `
        INSERT INTO billing_invoices (
          workspace_id, provider, provider_invoice_ref, status, currency,
          amount_due_minor, amount_paid_minor, amount_refunded_minor, paid_at
        ) VALUES ($1, 'stripe', $2, 'paid', 'usd', 2900, 2900, 500, $3);
      `,
      values: [workspace.id, `in-${suffix}`, '2026-08-08T12:00:00.000Z'],
    });
    await database.execute({
      text: `
        INSERT INTO billing_refunds (
          workspace_id, provider, provider_refund_ref, provider_invoice_ref,
          status, amount_minor, currency, reason
        ) VALUES ($1, 'stripe', $2, $3, 'succeeded', 500, 'usd', 'requested_by_customer');
      `,
      values: [workspace.id, `re-${suffix}`, `in-${suffix}`],
    });
    await database.execute({
      text: `
        INSERT INTO payment_webhook_events (
          provider, provider_event_ref, event_type, payload_json,
          workspace_id, status, attempts, error
        ) VALUES ('stripe', $2, 'invoice.payment_failed', '{}', $1, 'failed', 2, $3);
      `,
      values: [
        workspace.id,
        `evt-${suffix}`,
        'provider details must not be exposed',
      ],
    });

    const now = () => new Date('2026-08-08T13:00:00.000Z');
    const reads = new AsyncOperatorReadRepository(database, now);
    const overview = await reads.overview();
    const summary = await reads.workspace(workspace.id);
    const context = await reads.supportContext(workspace.id, ['workspace.billing.read']);
    if (
      overview.monthlyCredits < 25
      || overview.monthlyProviderCostMicros < 1200
      || !summary
      || summary.planKey !== 'pro'
      || summary.periodCredits !== 25
      || !context?.billing
    ) {
      throw new Error('PostgreSQL operator overview or Workspace summary is inconsistent');
    }
    const billing = new AsyncOperatorBillingReadRepository(database, now);
    const subscriptions = await billing.listSubscriptions(workspace.id, 10);
    const usage = await billing.listUsage(workspace.id, 10);
    const payments = await billing.listPayments(workspace.id, 10);
    if (
      subscriptions.length !== 1
      || subscriptions[0]?.planKey !== 'pro'
      || usage.length !== 1
      || usage[0]?.creditsCharged !== 25
      || payments.invoices.length !== 1
      || payments.refunds.length !== 1
      || payments.webhookFailures.length !== 1
      || !payments.webhookFailures[0]?.errorPresent
      || 'error' in (payments.webhookFailures[0] ?? {})
      || 'invoicePdfUrl' in (payments.invoices[0] ?? {})
    ) {
      throw new Error('PostgreSQL operator billing reads are not scoped and minimized');
    }
    process.stdout.write('postgres operator overview and billing reads smoke passed\n');
  } finally {
    await database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres operator billing smoke failed'}\n`);
  process.exitCode = 1;
});
