import { type AccountEmailDeliverySummary } from './accountEmailOutboxRepository';

export interface HttpMetricInput {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();

  observeHttpRequest(input: HttpMetricInput): void {
    this.increment('primalthrum_http_requests_total', {
      method: input.method,
      path: normalizePath(input.path),
      status: String(input.status),
    });
    this.increment('primalthrum_http_request_duration_ms_sum', {
      method: input.method,
      path: normalizePath(input.path),
      status: String(input.status),
    }, input.durationMs);
  }

  observeAccountEmail(outcome: string): void {
    this.increment('primalthrum_account_email_events_total', { outcome });
  }

  toPrometheusText(accountEmail?: AccountEmailDeliverySummary): string {
    const lines = [
      '# HELP primalthrum_http_requests_total Total HTTP requests handled by the server.',
      '# TYPE primalthrum_http_requests_total counter',
      '# HELP primalthrum_http_request_duration_ms_sum Total HTTP request duration in milliseconds.',
      '# TYPE primalthrum_http_request_duration_ms_sum counter',
      '# HELP primalthrum_process_uptime_seconds Server process uptime in seconds.',
      '# TYPE primalthrum_process_uptime_seconds gauge',
      '# HELP primalthrum_account_email_events_total Transactional email provider events.',
      '# TYPE primalthrum_account_email_events_total counter',
      '# HELP primalthrum_account_email_outbox Current transactional email outbox state.',
      '# TYPE primalthrum_account_email_outbox gauge',
      `primalthrum_process_uptime_seconds ${process.uptime().toFixed(3)}`,
    ];

    if (accountEmail) {
      const values: Record<string, number> = {
        pending: accountEmail.pending,
        delivering: accountEmail.delivering,
        delivered: accountEmail.delivered,
        retrying: accountEmail.retrying,
        dead_lettered: accountEmail.deadLettered,
        bounced: accountEmail.bounced,
        complained: accountEmail.complained,
      };
      for (const [status, value] of Object.entries(values)) {
        lines.push(`primalthrum_account_email_outbox{status="${status}"} ${value}`);
      }
    }

    for (const [key, value] of [...this.counters.entries()].sort()) {
      lines.push(`${key} ${value}`);
    }

    return `${lines.join('\n')}\n`;
  }

  private increment(
    name: string,
    labels: Record<string, string>,
    value = 1,
  ): void {
    const key = formatMetricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }
}

function normalizePath(path: string): string {
  return path.replace(/\/\d+(?=\/|$)/g, '/:id');
}

function formatMetricKey(name: string, labels: Record<string, string>): string {
  const renderedLabels = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(',');
  return `${name}{${renderedLabels}}`;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
