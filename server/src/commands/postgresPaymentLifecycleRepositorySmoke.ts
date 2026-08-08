import { randomUUID } from 'node:crypto';

import { PostgresDatabase } from '../db/postgres';
import { runPostgresMigrations } from '../db/postgresMigrations';
import { AsyncBillingPlanRepository } from '../services/asyncBillingPlanRepository';
import { AsyncCreditLedgerRepository } from '../services/asyncCreditLedgerRepository';
import { AsyncPaymentLifecycleRepository } from '../services/asyncPaymentLifecycleRepository';
import { AsyncUserRepository } from '../services/asyncUserRepository';
import { AsyncWorkspaceRepository } from '../services/asyncWorkspaceRepository';
import { type PaymentWebhookEvent } from '../services/paymentTypes';
import { PaymentWebhookProcessor } from '../services/paymentWebhookProcessor';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase({ connectionString, max: 4 });
  const marker = randomUUID();
  const now = () => new Date('2026-08-01T00:00:00.000Z');
  const users = new AsyncUserRepository(database);
  const workspaces = new AsyncWorkspaceRepository(database);
  const payments = new AsyncPaymentLifecycleRepository(database, now);
  const plans = new AsyncBillingPlanRepository(database);
  const credits = new AsyncCreditLedgerRepository(database, now);
  const processor = new PaymentWebhookProcessor(payments, {
    listPlans: () => plans.list(),
    grantCredits: (input) => credits.grant(input),
  });
  try {
    await runPostgresMigrations(database);
    const owner = await users.createUser(`payment-${marker}@example.com`, 'hash', true);
    const workspace = await workspaces.create(owner.id, `Payment ${marker}`);
    await payments.configurePrice('stripe', 'pro', `price_pro_${marker}`);
    const subscription = event('evt_subscription', 'customer.subscription.updated', 100, {
      id: `sub_${marker}`,
      customer: `cus_${marker}`,
      status: 'active',
      current_period_start: 100,
      current_period_end: 2_592_100,
      metadata: { workspace_id: String(workspace.id), plan_key: 'pro' },
      items: { data: [{ id: `si_${marker}`, price: { id: `price_pro_${marker}` } }] },
    });
    await processor.process(subscription, JSON.stringify(subscription), 100);
    const invoice = event('evt_invoice', 'invoice.paid', 200, {
      id: `in_${marker}`,
      customer: `cus_${marker}`,
      subscription: `sub_${marker}`,
      status: 'paid',
      paid: true,
      currency: 'usd',
      amount_due: 2900,
      amount_paid: 2900,
      period_start: 100,
      period_end: 2_592_100,
    });
    await processor.process(invoice, JSON.stringify(invoice), 200);
    const replay = await processor.process(invoice, JSON.stringify(invoice), 200);
    const subscriptionState = await payments.subscription(workspace.id);
    const account = await credits.account(workspace.id);
    const invoices = await payments.listInvoices(workspace.id);
    if (
      replay.status !== 'duplicate'
      || subscriptionState.state !== 'active'
      || subscriptionState.planKey !== 'pro'
      || account.availableCredits !== 26_000
      || invoices[0]?.providerInvoiceRef !== `in_${marker}`
    ) {
      throw new Error('PostgreSQL payment lifecycle state is inconsistent');
    }
    process.stdout.write('postgres payment lifecycle repository smoke passed\n');
  } finally {
    await database.close();
  }
}

function event(
  idPrefix: string,
  type: string,
  created: number,
  object: Record<string, unknown>,
): PaymentWebhookEvent {
  return {
    id: `${idPrefix}_${String(object.id)}`,
    type,
    created,
    livemode: false,
    api_version: '2025-06-30.basil',
    data: { object },
  };
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'postgres payment lifecycle smoke failed'}\n`);
  process.exitCode = 1;
});
