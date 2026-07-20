# Changelog

## 1.0.0 - 2026-07-20

Initial commercial-ready release candidate.

### Added

- Python Agent runtime with LangGraph stream contract.
- Node server with authenticated platform APIs, SSE proxy, jobs, audit logs, backup/restore, structured errors, readiness, and metrics.
- React web console for setup, provider settings, agent builder, knowledge, stream runs, onboarding, and error states.
- Configurable memory, cache, tools, skills, RAG, and model provider metadata.
- Document registration, indexing, reindexing, deletion, backup, and restore paths.
- Standalone generated Agent project skeleton.
- Demo Research Agent package and full commercial smoke script.
- Operator, user, troubleshooting, security, and release documentation.

### Verification

- `scripts/commercial-smoke.sh`
- `bash examples/research-agent/smoke.sh`
- `scripts/backup-restore-smoke.sh`
