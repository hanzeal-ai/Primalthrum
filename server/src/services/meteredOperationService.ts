import { createHash } from 'node:crypto';

import { BillingRepository } from './billingRepository';
import type { CreditReservationRecord, UsageEventRecord } from './billingTypes';
import { UsageRatingRepository } from './usageRatingRepository';

export interface MeteredOperation {
  workspaceId: number;
  reference: string;
  meter: string;
  quantity: number;
  provider: string;
  model: string;
  resourceType: string;
  resourceId: string;
}

export class MeteredOperationService {
  constructor(
    private readonly ratings: UsageRatingRepository,
    private readonly billing: BillingRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  begin(input: {
    workspaceId: number;
    idempotencyKey: string;
    meter: string;
    quantity: number;
    provider?: string;
    model?: string;
    resourceType: string;
  }): MeteredOperation {
    const occurredAt = this.now().toISOString();
    const quote = this.ratings.quote({
      meter: input.meter,
      quantity: input.quantity,
      provider: input.provider,
      model: input.model,
      occurredAt,
    });
    this.ratings.assertProjected(input.workspaceId, [quote], occurredAt);
    const reference = operationReference(input.workspaceId, input.idempotencyKey);
    this.billing.reserveCredits({
      workspaceId: input.workspaceId,
      idempotencyKey: `operation:${reference}`,
      meter: input.meter,
      credits: Math.max(1, quote.credits),
    });
    return {
      workspaceId: input.workspaceId,
      reference,
      meter: input.meter,
      quantity: input.quantity,
      provider: input.provider ?? '',
      model: input.model ?? '',
      resourceType: input.resourceType,
      resourceId: input.idempotencyKey,
    };
  }

  complete(
    operation: MeteredOperation,
    metadata: Record<string, unknown> = {},
    actualQuantity = operation.quantity,
  ): UsageEventRecord {
    const rated = this.ratings.rate({
      workspaceId: operation.workspaceId,
      idempotencyKey: `operation:${operation.reference}:rated`,
      meter: operation.meter,
      quantity: actualQuantity,
      provider: operation.provider,
      model: operation.model,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
      metadata,
      enforceBudget: false,
    });
    return this.billing.settleReservation({
      workspaceId: operation.workspaceId,
      reservationKey: `operation:${operation.reference}`,
      usageIdempotencyKey: `operation:${operation.reference}:settled`,
      quantity: rated.quantity,
      actualCredits: rated.creditsCharged,
      resourceType: operation.resourceType,
      resourceId: operation.resourceId,
      metadata: { ratedUsageEventId: rated.id, providerCostMicros: rated.providerCostMicros },
    });
  }

  release(operation: MeteredOperation): CreditReservationRecord {
    return this.billing.releaseReservation(
      operation.workspaceId,
      `operation:${operation.reference}`,
    );
  }
}

function operationReference(workspaceId: number, key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new Error('Idempotency-Key has an invalid format');
  }
  return createHash('sha256').update(`${workspaceId}:${key}`).digest('hex');
}
