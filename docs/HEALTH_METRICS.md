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

## Web And Worker Probes

The production Web image exposes `GET /healthz` from its no-dependency static
server. This checks the serving process; API readiness remains authoritative at
the Server `/ready` endpoint proxied through `/api` routes.

The standalone Worker has no public HTTP listener. Its production Compose health
check runs inside the Worker container and succeeds only while the Worker process
is alive and PostgreSQL accepts `SELECT 1`. Worker startup already applies and
validates database migrations before the process is considered running.

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

## Distributed Tracing

The Server accepts W3C `traceparent`, continues a valid incoming trace with a new
server Span, and returns the resulting `traceparent` plus `X-Request-ID`. Unsampled
incoming traces preserve their sampling decision and are not exported. Invalid or
all-zero identifiers start a new sampled root trace.

Production exports OpenTelemetry OTLP/HTTP JSON to the required HTTPS collector
configured by `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`. `OTEL_EXPORTER_OTLP_HEADERS`
accepts comma-separated URL-encoded `key=value` entries for collector authentication;
`OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION`, and
`OTEL_DEPLOYMENT_ENVIRONMENT` provide bounded delivery and resource identity.

The exporter batches up to 64 Spans, bounds its in-memory queue at 2,048, reports
overflow or collector failures through structured warning logs, and flushes queued
Spans during application shutdown. Export failure never fails a customer request.
HTTP attributes contain only method, matched Router template, status, and error type;
raw URL paths, query strings, request bodies, credentials, and user identifiers are
not exported. While tracing is enabled, the active W3C context propagates only to the
trusted Agent capability, Embedding, speech, and streaming endpoints. Request-local
async context keeps concurrent traces isolated; ordinary external provider requests do
not inherit the header, and caller-supplied trace headers are stripped outside an active
Server request. Live collector/dashboard acceptance remains a production launch gate.
Worker Job/Outbox Span instrumentation is also still required; the production Worker
service identity is reserved now so those future Spans cannot be merged with Server
request traces.

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
