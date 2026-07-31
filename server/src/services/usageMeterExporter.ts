export interface UsageMeterExportPayload {
  eventId: number;
  workspaceId: number;
  idempotencyKey: string;
  meter: string;
  provider: string;
  model: string;
  quantity: number;
  billableUnits: number;
  creditsCharged: number;
  providerCostMicros: number;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface UsageMeterExporter {
  readonly destination: string;
  send(payload: UsageMeterExportPayload): Promise<void>;
}

export class HttpUsageMeterExporter implements UsageMeterExporter {
  readonly destination = 'primary';

  constructor(
    private readonly endpoint: string,
    private readonly token = '',
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    new URL(endpoint);
  }

  async send(payload: UsageMeterExportPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `primalthrum-usage-${payload.eventId}`,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`usage meter export failed with status ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
