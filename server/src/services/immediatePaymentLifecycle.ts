import { type BillingStore } from './billingStore';
import { type BillingPlanRecord } from './billingTypes';
import { type PaymentLifecycleStore } from './paymentLifecycleStore';
import { type WorkspaceSubscriptionRecord } from './paymentTypes';

interface ActivatePlanInput {
  customerRef: string;
  idempotencyKey: string;
  plan: BillingPlanRecord;
  priceRef: string;
  sessionRef?: string;
  workspaceId: number;
}

export class ImmediatePaymentLifecycle {
  private latestEventCreated = 0;

  constructor(
    private readonly provider: string,
    private readonly payments: PaymentLifecycleStore,
    private readonly billing: BillingStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async activatePlan(input: ActivatePlanInput): Promise<WorkspaceSubscriptionRecord> {
    if (input.sessionRef) {
      await this.payments.completeCheckout(this.provider, input.sessionRef);
    }
    const eventCreated = this.nextEventCreated();
    const subscriptionRef = `mock_subscription_${input.workspaceId}`;
    await this.payments.applySubscriptionState({
      workspaceId: input.workspaceId,
      provider: this.provider,
      eventRef: `mock_${input.idempotencyKey}`,
      eventCreated,
      state: 'active',
      planKey: input.plan.key,
      customerRef: input.customerRef,
      subscriptionRef,
      priceRef: input.priceRef,
      subscriptionItemRef: `mock_item_${input.workspaceId}`,
      periodStartsAt: new Date(eventCreated * 1000).toISOString(),
      periodEndsAt: new Date((eventCreated + 30 * 24 * 60 * 60) * 1000).toISOString(),
      cancelAtPeriodEnd: false,
    });
    if (input.plan.monthlyCreditGrant > 0) {
      await this.billing.grantCredits({
        workspaceId: input.workspaceId,
        amount: input.plan.monthlyCreditGrant,
        idempotencyKey: `mock-plan:${input.idempotencyKey}`,
        sourceType: 'mock-payment',
        sourceRef: input.idempotencyKey,
      });
    }
    return this.payments.subscription(input.workspaceId);
  }

  async cancel(workspaceId: number, idempotencyKey: string): Promise<WorkspaceSubscriptionRecord> {
    const current = await this.payments.subscription(workspaceId);
    await this.payments.applySubscriptionState({
      workspaceId,
      provider: this.provider,
      eventRef: `mock_${idempotencyKey}`,
      eventCreated: this.nextEventCreated(),
      state: 'cancel_at_period_end',
      planKey: current.planKey,
      cancelAtPeriodEnd: true,
    });
    return this.payments.subscription(workspaceId);
  }

  private nextEventCreated(): number {
    const current = Math.floor(this.now().getTime() / 1000);
    this.latestEventCreated = Math.max(current, this.latestEventCreated + 1);
    return this.latestEventCreated;
  }
}
