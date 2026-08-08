import { type CreditLedgerStore } from './creditLedgerStore';
import { type RuntimeModelEndpoint } from './runtimeProviderResolver';
import { type UsageRatingStore } from './usageRatingStore';
import type { CreditReservationRecord, UsageEventRecord } from './billingTypes';

export class RunUsageService {
  constructor(
    private readonly ratings: UsageRatingStore,
    private readonly credits: CreditLedgerStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reserve(input: {
    runId: number;
    workspaceId: number;
    prompt: string;
    llm: RuntimeModelEndpoint;
    channel: 'hosted' | 'api';
  }): Promise<CreditReservationRecord> {
    const occurredAt = this.now().toISOString();
    const inputTokens = estimateTokens(input.prompt);
    const outputTokens = input.llm.max_tokens ?? 1024;
    const quotes = await Promise.all([
      this.ratings.quote({
        meter: input.channel === 'hosted' ? 'hosted.runs' : 'api.runs',
        quantity: 1,
        occurredAt,
      }),
      this.ratings.quote({
        meter: 'llm.input_tokens',
        quantity: inputTokens,
        provider: input.llm.provider,
        model: input.llm.model,
        occurredAt,
      }),
      this.ratings.quote({
        meter: 'llm.output_tokens',
        quantity: outputTokens,
        provider: input.llm.provider,
        model: input.llm.model,
        occurredAt,
      }),
    ]);
    await this.ratings.assertProjected(input.workspaceId, quotes, occurredAt);
    return this.credits.reserve({
      workspaceId: input.workspaceId,
      idempotencyKey: reservationKey(input.runId),
      meter: 'run.total',
      credits: Math.max(1, quotes.reduce((sum, quote) => sum + quote.credits, 0)),
    });
  }

  recordRun(input: {
    runId: number;
    workspaceId: number;
    channel: 'hosted' | 'api';
  }): Promise<void> {
    return this.record(input, {
      suffix: input.channel,
      meter: input.channel === 'hosted' ? 'hosted.runs' : 'api.runs',
      quantity: 1,
    });
  }

  recordLlmUsage(input: {
    runId: number;
    workspaceId: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    return this.recordLlmMeters(input);
  }

  private async recordLlmMeters(input: {
    runId: number;
    workspaceId: number;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }): Promise<void> {
    await this.record(input, {
      suffix: 'llm-input',
      meter: 'llm.input_tokens',
      quantity: input.inputTokens,
      provider: input.provider,
      model: input.model,
    });
    await this.record(input, {
      suffix: 'llm-output',
      meter: 'llm.output_tokens',
      quantity: input.outputTokens,
      provider: input.provider,
      model: input.model,
    });
  }

  recordEmbedding(input: {
    runId: number;
    workspaceId: number;
    provider: string;
    model: string;
    tokenCount: number;
    purpose: string;
  }): Promise<void> {
    return this.record(input, {
      suffix: `embedding-${input.purpose}`,
      meter: 'embedding.tokens',
      quantity: input.tokenCount,
      provider: input.provider,
      model: input.model,
    });
  }

  recordToolCall(input: {
    runId: number;
    workspaceId: number;
    eventId: number;
    tool: string;
  }): Promise<void> {
    return this.record(input, {
      suffix: `tool-${input.eventId}`,
      meter: 'tool.calls',
      quantity: 1,
      metadata: { tool: input.tool },
    });
  }

  recordRetrieval(input: {
    runId: number;
    workspaceId: number;
    matchCount: number;
  }): Promise<void> {
    return this.record(input, {
      suffix: 'rag-retrieval',
      meter: 'rag.retrievals',
      quantity: 1,
      metadata: { matchCount: input.matchCount },
    });
  }

  async settle(
    runId: number,
    workspaceId: number,
  ): Promise<UsageEventRecord | CreditReservationRecord> {
    const totals = await this.ratings.totalsForResource(workspaceId, 'run', String(runId));
    if (totals.eventCount === 0) {
      return this.credits.release(workspaceId, reservationKey(runId));
    }
    return this.credits.settle({
      workspaceId,
      reservationKey: reservationKey(runId),
      usageIdempotencyKey: `run:${runId}:settlement`,
      quantity: totals.quantity,
      actualCredits: totals.credits,
      resourceType: 'run',
      resourceId: String(runId),
      metadata: {
        ratedEventCount: totals.eventCount,
        providerCostMicros: totals.providerCostMicros,
      },
    });
  }

  private record(
    resource: { runId: number; workspaceId: number },
    usage: {
      suffix: string;
      meter: string;
      quantity: number;
      provider?: string;
      model?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    return Promise.resolve(this.ratings.rate({
      workspaceId: resource.workspaceId,
      idempotencyKey: `run:${resource.runId}:${usage.suffix}`,
      meter: usage.meter,
      quantity: usage.quantity,
      provider: usage.provider,
      model: usage.model,
      resourceType: 'run',
      resourceId: String(resource.runId),
      metadata: usage.metadata,
      enforceBudget: false,
    })).then(() => undefined);
  }
}

function reservationKey(runId: number): string {
  return `run:${runId}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
