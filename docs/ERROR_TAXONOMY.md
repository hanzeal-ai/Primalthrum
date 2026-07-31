# Error Taxonomy

Primalthrum server APIs use a standard error payload for run, job, provider configuration, and document workflows.

## Payload

```json
{
  "error": {
    "code": "RUN_NOT_FOUND",
    "message": "run not found",
    "status": 404
  }
}
```

The optional `error.details` object is reserved for diagnostic metadata. API clients should branch on `error.code` instead of parsing `error.message`.

## Logging

`server/src/services/logger.ts` provides a structured logger interface and a JSON console implementation. `sendApiError` writes one structured log entry for every standardized API error:

- `warn` for 4xx client or missing-resource errors.
- `error` for 5xx server or dependency failures.
- Log context includes HTTP method, path, status, and optional details.

Tests inject a silent logger so payload assertions stay deterministic.

## Codes

| Code | Status | Workflow |
| --- | --- | --- |
| `RATE_LIMIT_EXCEEDED` | 429 | A source, identity, user, or public resource exceeded its bounded request window. |
| `BOT_CHALLENGE_REQUIRED` | 403 | A protected public conversion request lacks a valid action-bound challenge. |
| `BOT_CHALLENGE_UNAVAILABLE` | 503 | The configured challenge verifier timed out or failed closed. |
| `PRIVACY_CONSENT_INVALID` | 400 | Privacy consent is malformed or targets an outdated policy version. |
| `ANALYTICS_CONSENT_REQUIRED` | 403 | The supplied receipt is not the subject's latest analytics grant. |
| `ANALYTICS_EVENT_INVALID` | 400/409 | The event violates the allowlist, time window, or idempotency contract. |
| `TRIAL_NOT_ELIGIBLE` | 409 | The user or workspace already consumed a one-time trial. |
| `TRIAL_PLAN_INVALID` | 409 | The selected plan has no activatable trial. |
| `TRIAL_REQUEST_INVALID` | 400 | The trial request payload is invalid. |
| `ENTITLEMENT_REQUIRED` | 403 | The effective subscription and grants do not enable a feature. |
| `ENTITLEMENT_LIMIT_EXCEEDED` | 409 | A requested quantity exceeds the effective entitlement. |
| `CREDIT_LIMIT_EXCEEDED` | 402 | Available credit cannot cover a reservation or settlement. |
| `DOCUMENT_AGENT_NOT_FOUND` | 404 | Document operation references a missing agent. |
| `DOCUMENT_INVALID` | 400 | Document registration payload is invalid. |
| `DOCUMENT_INDEX_FAILED` | 500 | Document indexing job failed. |
| `SPEECH_REQUEST_INVALID` | 400 | Audio, text, or speech provider selection is invalid. |
| `SPEECH_PROVIDER_FAILED` | 502 | The configured STT/TTS provider failed. |
| `DOCUMENT_NOT_FOUND` | 404 | Document operation references a missing document. |
| `JOB_NOT_FOUND` | 404 | Job lookup references a missing job. |
| `PROVIDER_CONFIG_INVALID` | 400 | Provider configuration payload is invalid. |
| `PROVIDER_CONFIG_NOT_FOUND` | 404 | Provider configuration update/delete references a missing config. |
| `RUN_AGENT_NOT_FOUND` | 404 | Run creation references a missing agent. |
| `RUN_EVENT_INVALID` | 400 | Run event append payload is invalid. |
| `RUN_ID_INVALID` | 400 | Run-scoped query uses an invalid run id. |
| `RUN_INVALID` | 400 | Run creation payload is invalid. |
| `RUN_NOT_FOUND` | 404 | Run lookup or run event operation references a missing run. |
