export type CommercialSubscriptionState =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'restricted'
  | 'cancel_at_period_end'
  | 'canceled'
  | 'refunded';

export interface PaymentPriceRecord {
  provider: string;
  planKey: string;
  providerPriceRef: string;
  active: boolean;
}

export interface PaymentCustomerRecord {
  workspaceId: number;
  provider: string;
  providerCustomerRef: string;
  email: string;
}

export interface PaymentCheckoutRecord {
  id: number;
  workspaceId: number;
  provider: string;
  idempotencyKey: string;
  providerSessionRef: string;
  planKey: string;
  status: string;
  checkoutUrl: string;
  expiresAt: string | null;
  completedAt: string | null;
}

export interface WorkspaceSubscriptionRecord {
  workspaceId: number;
  planKey: string;
  state: CommercialSubscriptionState;
  periodStartsAt: string;
  periodEndsAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string;
  providerCustomerRef: string;
  providerSubscriptionRef: string;
  providerPriceRef: string;
  providerSubscriptionItemRef: string;
  pendingPlanKey: string;
  graceEndsAt: string | null;
  canceledAt: string | null;
}

export interface BillingInvoiceRecord {
  id: number;
  workspaceId: number;
  provider: string;
  providerInvoiceRef: string;
  status: string;
  currency: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  periodStartsAt: string | null;
  periodEndsAt: string | null;
  hostedInvoiceUrl: string;
  invoicePdfUrl: string;
  dueAt: string | null;
  paidAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentWebhookEvent {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  api_version?: string | null;
  data: { object: Record<string, unknown> };
}

export interface PaymentWebhookResult {
  eventId: string;
  status: 'processed' | 'ignored' | 'duplicate';
  workspaceId: number | null;
}

export class PaymentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
