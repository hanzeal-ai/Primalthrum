# Usage Rating And Cost Controls

Primalthrum records raw meter evidence separately from the credit ledger. A
versioned price converts each raw quantity into billable units, platform credits,
and provider cost in integer micro-US dollars. Runtime settlement later sums the
rated events for one resource and posts one atomic ledger settlement.

The usage rating repository supports parameterized asynchronous SQLite and
PostgreSQL access. Rating obtains a workspace-scoped transaction lock before the
budget check and immutable event insertion, so concurrent requests cannot bypass
a hard monthly limit. Repository tests exercise the asynchronous SQLite adapter
and the real PostgreSQL smoke suite.

Every persisted Run performs this lifecycle before contacting a model:

```text
quote input/output/run -> enforce monthly controls -> reserve credits
-> execute -> record provider/platform evidence -> settle aggregate actuals
                                      -> no evidence on failure -> release
```

The Agent emits `agent.usage.reported` after model streaming. OpenAI-compatible
providers request the terminal usage chunk, Anthropic consumes message usage
events, and the deterministic Mock provider reports a stable estimate. Embedding
responses carry provider token usage when available; compatible endpoints that
omit it fall back to a character estimate. Tool calls, RAG retrieval, and
hosted/API run units are recorded by Node from persisted stream events.

Speech and storage use the same preflight contract through a reusable metered
operation service. STT is billed by client-measured recording seconds, TTS by
input characters, file storage by validated upload bytes, document Embedding by
provider token usage, and RAG storage by indexed document bytes. The Web client
sends a new stable idempotency key for each speech or upload operation. Provider
or storage failures release their reservation; successful work settles the rated
actual quantity.

## Meters

The initial data-driven catalog covers:

- `llm.input_tokens` and `llm.output_tokens`
- `embedding.tokens`
- `speech.transcription_seconds`
- `speech.synthesis_characters`
- `tool.calls`
- `rag.retrievals` and `rag.storage_bytes`
- `file.storage_bytes`
- `hosted.runs` and `api.runs`

Prices are selected by effective pricing version, meter, provider, and model.
Provider/model-specific rows override wildcard rows. Each event stores the exact
`meter_price_id`, so historical charges do not change when future prices change.
Quantities, credits, and costs are non-negative integers; partial units round up.

## Evidence And Idempotency

`rated_usage_events` is append-only and rejects updates and deletes. The unique
workspace idempotency key represents one provider or platform measurement. A
replay with the same meter, quantity, provider, model, and timestamp returns the
original record; changed evidence is rejected.

## External Meter Export

Migration 018 creates one `usage_meter_exports` outbox row for every immutable
rated event and backfills existing evidence. When `USAGE_METER_EXPORT_URL` is
configured, a background dispatcher posts pending events to that endpoint. The
request uses `primalthrum-usage-<event-id>` as its stable `Idempotency-Key` and
optionally sends `USAGE_METER_EXPORT_TOKEN` as a Bearer token.

External delivery does not participate in the customer request transaction.
Failures retain the event, error, attempt count, and exponentially delayed next
attempt; an unreferenced timer wakes the dispatcher when it becomes due. A
five-minute delivery lease lets another process recover interrupted work.
Successfully delivered rows are terminal and are not sent again.

## Cost Controls

`workspace_cost_controls` supports optional monthly credit and provider-cost
limits, hard-stop behavior, explicit overage permission, and configurable alert
thresholds. Before recording a new event, the rating engine projects both limits.
With hard stop enabled and overage disabled, either excess is rejected before
usage evidence is inserted.

Crossed thresholds create one `cost_alerts` record per workspace, UTC month,
metric, and percentage. The default thresholds are 50, 80, and 100 percent.
Delivery is a later notification concern; the threshold evidence remains durable.

## HTTP Surface

- `GET /api/billing/usage`: current UTC period totals, meter breakdown, and controls.
- `GET /api/billing/cost-controls`: current workspace limits and thresholds.
- `PUT /api/billing/cost-controls`: Owner or Billing updates limits and policy.
- `GET /api/billing/cost-alerts`: durable threshold crossings for the workspace.

All endpoints are workspace-scoped and use server-side billing permissions.

## Invariants

1. Every rated event references the price used at occurrence time.
2. Provider cost uses integer micro-USD and never floating-point currency.
3. A usage idempotency key cannot be reused with different evidence.
4. Hard limits are checked against current period totals plus projected usage.
5. Alert rows are idempotent across retries.
6. Runtime ledger settlement must reconcile to the sum of its rated events.
7. A failed Run with no consumed evidence releases its entire reservation.
8. Consumed evidence is settled even when the Run later fails or disconnects.
9. Every rated event has one durable export row per destination.
10. External delivery never blocks or rolls back local rating and settlement.
