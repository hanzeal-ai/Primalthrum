# Health And Metrics

Primalthrum exposes health, readiness, and metrics endpoints for production runtime checks.

## Server Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Lightweight liveness check for the Node server process. |
| `GET /ready` | Public | Readiness check for database, document storage, and Agent runtime access. |
| `GET /metrics` | Public | Prometheus text metrics export. |

`/ready` returns HTTP 200 when all checks pass and HTTP 503 when one or more dependencies fail.

```json
{
  "status": "ready",
  "service": "server",
  "checks": [
    { "name": "database", "status": "ok", "latencyMs": 4 },
    { "name": "document_storage", "status": "ok", "latencyMs": 8 },
    { "name": "agent_runtime", "status": "ok", "latencyMs": 12 }
  ]
}
```

The server checks Agent readiness through `${AGENT_BASE_URL}/ready` and calls the
configured storage provider health check. For S3-compatible storage this is a
signed bucket `HEAD`; failed authentication, timeout, or bucket access returns 503.

## Agent Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Lightweight liveness check for the Python Agent process. |
| `GET /ready` | Validates the runtime registry and LangGraph graph availability. |

## Metrics

`/metrics` exports:

- `primalthrum_http_requests_total`: request count labeled by method, normalized path, and status.
- `primalthrum_http_request_duration_ms_sum`: total request duration in milliseconds with the same labels.
- `primalthrum_process_uptime_seconds`: Node process uptime gauge.
- `primalthrum_account_email_events_total`: unique signed Provider delivery events.
- `primalthrum_account_email_outbox`: pending, retrying, dead-letter, bounce, and
  complaint state gauges.
- `primalthrum_abuse_enforcement_total`: bounded rate-limit, challenge-failure,
  and challenge-outage counters by rule and outcome.

Numeric path segments are normalized to `/:id` to avoid unbounded metric labels.

## Deployment Probes

Use `/health` for process liveness and `/ready` for traffic routing readiness. Example Kubernetes-style split:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
```
