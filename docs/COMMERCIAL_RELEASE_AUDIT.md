# Commercial Release Audit

Audit date: 2026-08-21

Overall result: **Not releasable**. Local automated evidence is green, but the
external and human gates below are still required. This file records evidence;
it does not replace `COMMERCIAL_PRODUCT_SPEC.md` or waive a release condition.

## Release Requirements

| Requirement | Current evidence | Result | Remaining gate |
| --- | --- | --- | --- |
| Website through payment lifecycle | Zero-retry Playwright covers signup, verification, trial, Checkout handoff, renewal failure/recovery, cancellation, invoice, and refund states. | Partial | Execute the documented lifecycle against operator-owned Stripe sandbox credentials. |
| Non-technical hosted Agent creation and use | `commercialJourney.spec.ts` creates and opens an Agent entirely through Web UI and completes a streamed conversation. | Passed locally | Repeat in the selected production ingress. |
| Text, voice, attachments, Tool, Skill, Memory, Cache, and optional RAG | Browser tests cover text, browser speech input/playback, permission denial, file upload, SQLite RAG/source rendering, Tool readiness, Skill application, durable Memory read/write, and a repeated-request Cache hit. | Partial | Complete a physical microphone STT/TTS round trip. |
| Usage, reservation, settlement, idempotency, quota, and entitlements | Server suite covers immutable rating, reservation races, settlement/release, limits, alerts, refunds, and reconciliation. | Passed locally | Reconcile one selected live Provider billing period before launch. |
| Tenant isolation and security matrix | Browser tests cover two-Workspace Agent isolation and all six Workspace roles. Server tests cover tenant repositories, MFA, API keys, abuse controls, SSRF, malware scanning, privacy, retention, and legal holds. | Partial | Complete independent manual security and threat-model signoff in the production topology. |
| Responsive desktop and mobile browser acceptance | Zero-retry Playwright covers desktop customer/operator workflows and mobile role navigation without horizontal overflow. | Passed locally | Repeat the production browser smoke after deployment. |
| Monitoring, alerting, backup, restore, migration, and rollback | Local smoke covers metrics contracts, backup/restore, migration, version rollback, production artifacts, and deployment topology checks. | Partial | Retain production dashboard/alert, Provider ingress, secret rotation, PITR/RPO/RTO, and incident evidence. |
| Legal, support, pricing, status, security, and operator documentation | Required product and operator documentation exists in `docs/`; public pricing, status, security, privacy, and terms surfaces exist. | Partial | Obtain qualified legal approval and jurisdiction-specific schedules. |

## Local Aggregate Evidence

`scripts/commercial-smoke.sh` passed with browser retries disabled:

- Agent: 33 tests.
- Server: 238 tests plus typecheck and production build.
- Web: 76 unit tests, 4 production-server tests, lint, and production build.
- Browser: 20 desktop/mobile scenarios.
- Deployment artifact, generated demo Agent, and backup/restore smokes.

## External Inputs Required

- Stripe sandbox account, Price mappings, Webhook secret, and test payment method.
- Sending domain, real verification/reset mailboxes, and bounce/complaint alert sink.
- Turnstile production site/secret keys and deployed trusted-proxy topology.
- Selected live LLM, Embedding, STT, and TTS Provider credentials.
- Physical microphone/playback devices for supported browser acceptance.
- Production secret manager, retained monitoring backend, and alert destinations.
- Qualified legal approver and independent security reviewer.

## Remaining Gates

No additional local product-code gap is identified by this audit. Do not mark P23
or P24 `Done` until the external, physical-device, production-topology, legal, and
independent-security gates above are supported by current evidence.
