# Primalthrum Commercial SaaS Product Specification

## Purpose

Primalthrum is a commercial, multi-tenant Agent SaaS. A customer describes an
Agent in a voice or text conversation, resolves required choices inside that
conversation, and opens the resulting Agent as a hosted web application. Source
export remains available, but a terminal is never required to create or use an
Agent.

This document is the product contract for the commercial roadmap. The
implementation plan lives in `docs/AI_ITERATION_PLAN.md`.

## Launch Assumptions

- Global, web-first SaaS with responsive desktop and mobile browser support.
- English and Chinese localization-ready interfaces.
- Subscription plus included usage credit, with optional metered overage.
- A payment adapter with Stripe as the first implementation and room for local
  payment providers.
- Shared managed runtime by default, with isolated enterprise deployments later.
- PostgreSQL, Redis, object storage, and managed secret storage in production.
- SQLite, local storage, mock providers, and no-key mode remain supported for
  local development.

## Product Surfaces

### Public Website

Required routes:

- `/`: product home with a real Agent interaction as the first viewport signal.
- `/product`: builder, hosted Agent, knowledge, voice, tools, and API capabilities.
- `/solutions`: individual, team, support, research, and enterprise use cases.
- `/templates`: searchable Agent templates with a direct use flow.
- `/pricing`: plan comparison, included usage, overage, FAQ, and refund summary.
- `/security`: architecture, data controls, subprocessors, and security contact.
- `/docs`: product and developer documentation.
- `/blog`: product education and release content.
- `/contact`: sales and support contact.
- `/status`: public service status.
- `/legal/*`: terms, privacy, cookies, refund policy, DPA, and SLA.

### Authenticated Application

Required routes:

- `/app`: recent Agents, conversations, usage, and onboarding state.
- `/app/create`: conversational Agent builder.
- `/app/agents`: Agent catalog and lifecycle management.
- `/app/agents/:agentId/edit`: conversational editing and advanced configuration.
- `/app/agents/:agentId/versions`: draft, preview, publish, and rollback history.
- `/app/knowledge`: documents, collections, ingestion, and indexing operations.
- `/app/usage`: usage, cost, credits, limits, and exports.
- `/app/billing`: plan, subscription, invoices, payment method, and cancellation.
- `/app/team`: members, role management, seat usage, and invitations.
- `/app/team`: members, invitations, roles, and seat usage.
- `/app/settings`: workspace, providers, API keys, retention, and security.
- `/a/:agentSlug`: hosted Agent application.

### Operations Application

The operator surface must provide workspace, user, subscription, usage, payment,
Agent, job, abuse, support, feature flag, and system health views. Support access
must be explicit, time-limited, and audited.

## Canonical User Journeys

### Visitor To Activated Trial

1. Visitor opens the website, pricing page, or an Agent template.
2. Visitor signs up using email or an enabled OAuth provider.
3. Email verification creates a personal workspace and one trial grant.
4. The user enters the conversational builder immediately.
5. Activation is achieved when an Agent reaches `ready` and its hosted page
   completes one successful conversation.

### Conversational Agent Creation

1. User describes the desired Agent using text or voice.
2. The builder extracts a structured `AgentDraft` from the conversation.
3. Missing decisions appear as inline choice, toggle, upload, or confirmation
   blocks. The user never has to fill a multi-step form.
4. The user may upload knowledge files or explicitly skip them.
5. Primalthrum validates providers, permissions, plugin dependencies, graph
   compilation, and runtime health.
6. A successful draft becomes a versioned Agent with status `ready`.
7. `Open Agent` navigates directly to `/a/:agentSlug`.

### Hosted Agent Use

1. User starts or resumes a conversation.
2. Text, voice, and permitted attachments share one composer.
3. Responses stream as message deltas while tool and retrieval activity remains
   inspectable without overwhelming the conversation.
4. Sources, tool results, failures, cost, and stop/retry controls are available.
5. Conversation and usage records persist according to workspace retention.

### Upgrade And Renewal

1. Verified accounts receive one seven-day Pro trial with a fixed cost ceiling.
2. At 50%, 80%, and 100% of trial credit, the product shows increasingly clear
   usage messages. Paid operations stop at 100%.
3. Trial-ending reminders are sent three days and one day before expiry.
4. A user can attach a payment method and start immediately or at trial end.
5. Unconverted trials downgrade to Free without deleting customer data.
6. Paid invoices activate entitlements. Failed payment enters a grace period,
   then restricts paid operations while preserving export, billing, and deletion.

## Agent Lifecycle

Canonical statuses:

- `draft`: requirements are incomplete or unpublished.
- `configuring`: the platform is resolving configuration and dependencies.
- `validating`: graph, provider, plugin, and stream smoke checks are running.
- `ready`: hosted preview is usable.
- `published`: a fixed version is serving its allowed audience.
- `failed`: validation failed with an actionable error.
- `suspended`: policy, quota, billing, or operator action prevents execution.
- `archived`: hidden from normal use but retained according to policy.

Creation is complete only when configuration is persisted, all selected
providers resolve, the LangGraph compiles, plugin dependencies load, a stream
smoke run completes, and the hosted route is available.

Every edit creates a draft version. Published versions are immutable. Rollback
creates a new draft from an older version and never mutates audit history.

## Runtime Capabilities

The following systems are first-class, manifest-driven runtime capabilities:

- LLM and node-level model slots.
- Embedding providers.
- Speech-to-text and text-to-speech providers.
- Skills that package instructions, workflow, dependencies, and tests.
- Tools with structured input/output, permission, risk, and timeout metadata.
- Memory providers for summaries, preferences, durable facts, and run state.
- Cache providers for tool, embedding, retrieval, and optional LLM results.
- RAG providers with an explicit disabled mode and selectable vector store.

Each manifest declares identity, version, capability, configuration schema,
dependencies, permissions, health check, lifecycle hooks, and compatibility.
Plugins may be installed and activated between runs, but never replaced during
an active run.

## Commercial Model

### Plans

Initial configurable catalog:

- Free: one seat, two Agents, basic models, and a small monthly credit grant.
- Pro: individual plan with voice, RAG, publishing, API access, and source export.
- Team: pooled usage, multiple seats, RBAC, shared knowledge, and audit history.
- Business: SSO, higher limits, retention controls, and priority support.
- Enterprise: negotiated limits, isolation, data region, private deployment, SLA,
  and security review.

Prices, limits, feature mappings, included credits, and overage policy are data,
not constants in application code.

### Subscription State

Canonical internal states:

- `trialing`
- `active`
- `past_due`
- `restricted`
- `cancel_at_period_end`
- `canceled`
- `refunded`

Payment provider state is evidence, not the product authorization model. Signed,
idempotent webhook processing updates internal subscriptions and entitlements.
The frontend never grants paid access.

### Entitlements

Every protected operation checks an entitlement snapshot including feature,
quantity limit, current usage, period, and source grant. Subscription plans,
trial grants, promotional credits, enterprise overrides, and operator grants
must compose without special cases in feature code.

### Usage And Ledger

Meter at minimum:

- LLM input and output tokens by provider and model.
- Embedding tokens.
- Speech recognition seconds.
- Speech synthesis characters or seconds.
- Tool calls and metered runtime.
- RAG storage and retrieval.
- File storage.
- Hosted Agent and API runs.

Every run follows estimate, reserve, execute, settle, release. The immutable
usage and credit ledger is the billing source of truth. External meter reporting
is asynchronous and idempotent. Failed or canceled work must not charge for
resources that were not consumed.

## Multi-Tenancy And Access

- Users belong to workspaces through memberships.
- Roles are Owner, Admin, Developer, Member, Billing, and Viewer.
- Server-side authorization combines role, resource ownership, entitlement, and
  optional enterprise policy.
- Every business row carries `workspace_id`; every repository query enforces it.
- Public Agent access uses a dedicated audience policy and never bypasses runtime
  quota or abuse controls.
- API keys are scoped, hashed at rest, revocable, and last-used audited.

## Data Domains

Required production domains:

- Identity: users, identities, sessions, MFA, workspaces, memberships, invites.
- Billing: plans, prices, subscriptions, entitlements, credits, usage events,
  invoices, payment customers, webhook events, refunds.
- Agent: agents, versions, deployments, provider bindings, plugin bindings.
- Conversation: conversations, messages, content parts, attachments, runs,
  stream events, sources, tool calls.
- Knowledge: collections, documents, document versions, chunks, indexes.
- Operations: jobs, audit logs, feature flags, incidents, support access.

Production migrations must be transactional, backward compatible during rolling
deployments, and covered by upgrade and restore tests.

## API And Stream Contract

`POST /api/stream` remains the canonical stream entry. Requests identify a mode:

- `builder`: continue a builder conversation and emit UI decision blocks.
- `agent`: run a specific Agent version in a specific conversation.

Canonical events:

- `message.started`
- `message.delta`
- `message.completed`
- `choice.required`
- `tool.started`
- `tool.completed`
- `rag.sources`
- `usage.updated`
- `agent.created`
- `run.completed`
- `run.error`

Every event includes event ID, run ID, sequence, timestamp, workspace ID, and a
typed payload. Clients can reconnect using the last sequence and replay persisted
events without duplicating messages or charges.

## Security And Privacy

- Provider and payment secrets use encrypted references backed by managed keys.
- Payment card data is handled by a hosted payment surface, not Primalthrum.
- Authentication supports secure cookies, session rotation, revocation, MFA, and
  rate limiting.
- Uploads enforce size, MIME, extension, malware, tenant, and retention policies.
- Dangerous tools require explicit policy and may require per-call approval.
- Tenant isolation, authorization, webhook replay, quota race, upload, and SSRF
  tests are mandatory release gates.
- Customers can export and delete account, conversation, Agent, knowledge, and
  billing-adjacent data according to legal retention obligations.
- Privacy, terms, cookie, refund, DPA, subprocessors, incident response, and
  retention documents must exist before public launch.

## Operations And Reliability

- PostgreSQL is the production metadata and ledger store.
- Redis provides cache, distributed quota reservation, locks, and queue support.
- Object storage holds customer files and optional transient audio.
- Worker processes handle ingestion, indexing, long tools, and media jobs.
- OpenTelemetry-compatible traces, structured logs, metrics, dashboards, and
  alerts cover signup, payment, stream, providers, jobs, cost, and availability.
- Backups are encrypted, retention-controlled, and restored in automated tests.
- Deployments support health, readiness, migrations, rollback, and zero-downtime
  configuration changes.

## Product Metrics

Track the full funnel:

- Visitor to verified signup.
- Verified signup to first Agent ready.
- Agent ready to first successful hosted conversation.
- Trial activation, trial conversion, and time to value.
- Weekly active workspaces, successful runs, retention, and churn.
- MRR, expansion, refunds, provider cost, gross margin, and unpaid usage.
- Stream success, first-token latency, tool failure, retrieval quality, and voice
  transcription failure.

Analytics must avoid storing prompts or customer content unless the workspace
explicitly allows content analytics.

## Commercial Release Gate

The product is commercially releasable only when:

- Website, signup, trial, checkout, subscription, renewal, failure, cancellation,
  invoice, and refund journeys pass end-to-end tests.
- A non-technical user creates and uses a hosted Agent without a terminal.
- Text, voice, attachments, tools, skills, memory, cache, and optional RAG work
  through the hosted application.
- Usage, reservation, settlement, idempotency, quota, and entitlement tests pass.
- Tenant isolation and the security test matrix pass.
- Responsive desktop and mobile browser acceptance passes.
- Production monitoring, alerting, backup, restore, migration, and rollback are
  demonstrated with retained evidence.
- Legal, support, pricing, status, security, and operator documentation exists.

Passing the legacy P1-P14 self-hosted smoke suite proves the foundation only. It
does not prove this commercial SaaS specification.
