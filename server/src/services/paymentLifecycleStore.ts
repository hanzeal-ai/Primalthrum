import { type Awaitable } from './storeTypes';
import type {
  BillingInvoiceRecord,
  CommercialSubscriptionState,
  PaymentCheckoutRecord,
  PaymentCustomerRecord,
  PaymentPriceRecord,
  PaymentWebhookEvent,
  WorkspaceSubscriptionRecord,
} from './paymentTypes';

export interface RecordCheckoutInput {
  workspaceId: number;
  provider: string;
  idempotencyKey: string;
  providerSessionRef: string;
  planKey: string;
  checkoutUrl: string;
  createdByUserId: number;
  expiresAt?: string | null;
}

export interface ApplySubscriptionStateInput {
  workspaceId: number;
  provider: string;
  eventRef: string;
  eventCreated: number;
  state: CommercialSubscriptionState;
  planKey: string;
  customerRef?: string;
  subscriptionRef?: string;
  priceRef?: string;
  subscriptionItemRef?: string;
  periodStartsAt?: string | null;
  periodEndsAt?: string | null;
  trialEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  graceEndsAt?: string | null;
}

export interface UpsertInvoiceInput {
  workspaceId: number;
  provider: string;
  invoiceRef: string;
  customerRef?: string;
  subscriptionRef?: string;
  status: string;
  currency?: string;
  amountDueMinor?: number;
  amountPaidMinor?: number;
  amountRefundedMinor?: number;
  periodStartsAt?: string | null;
  periodEndsAt?: string | null;
  hostedInvoiceUrl?: string;
  invoicePdfUrl?: string;
  dueAt?: string | null;
  paidAt?: string | null;
}

export interface UpsertRefundInput {
  workspaceId: number;
  provider: string;
  refundRef: string;
  paymentRef?: string;
  invoiceRef?: string;
  status: string;
  amountMinor?: number;
  currency?: string;
  reason?: string;
  providerCreatedAt?: string | null;
}

export interface RecordInvoiceRefundInput {
  workspaceId: number;
  provider: string;
  invoiceRef: string;
  amountRefundedMinor: number;
  status: string;
}

export interface PaymentLifecycleStore {
  configurePrice(
    provider: string,
    planKey: string,
    priceRef: string,
  ): Awaitable<PaymentPriceRecord>;
  priceForPlan(provider: string, planKey: string): Awaitable<PaymentPriceRecord | null>;
  planForPrice(provider: string, priceRef: string): Awaitable<string | null>;
  customer(
    workspaceId: number,
    provider: string,
  ): Awaitable<PaymentCustomerRecord | null>;
  upsertCustomer(input: PaymentCustomerRecord): Awaitable<PaymentCustomerRecord>;
  workspaceForProviderObject(
    provider: string,
    customerRef: string,
    subscriptionRef?: string,
  ): Awaitable<number | null>;
  recordCheckout(input: RecordCheckoutInput): Awaitable<PaymentCheckoutRecord>;
  checkoutByKey(
    workspaceId: number,
    provider: string,
    key: string,
  ): Awaitable<PaymentCheckoutRecord | null>;
  completeCheckout(provider: string, sessionRef: string): Awaitable<void>;
  markPendingPlan(workspaceId: number, planKey: string): Awaitable<void>;
  receiveWebhook(
    provider: string,
    event: PaymentWebhookEvent,
    rawPayload: string,
    signatureTimestamp: number | null,
  ): Awaitable<boolean>;
  finishWebhook(
    provider: string,
    eventRef: string,
    status: 'processed' | 'ignored' | 'failed',
    workspaceId: number | null,
    error?: string,
  ): Awaitable<void>;
  subscription(workspaceId: number): Awaitable<WorkspaceSubscriptionRecord>;
  applySubscriptionState(input: ApplySubscriptionStateInput): Awaitable<boolean>;
  upsertInvoice(input: UpsertInvoiceInput): Awaitable<void>;
  upsertRefund(input: UpsertRefundInput): Awaitable<void>;
  recordInvoiceRefund(input: RecordInvoiceRefundInput): Awaitable<void>;
  listInvoices(workspaceId: number): Awaitable<BillingInvoiceRecord[]>;
}
