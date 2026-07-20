# Release Gate

Primalthrum uses semantic versioning for commercial releases.

## Version Convention

- `MAJOR`: incompatible API, generated-agent contract, or data migration changes.
- `MINOR`: backward-compatible product features or provider additions.
- `PATCH`: bug fixes, docs fixes, and compatible operational improvements.

The product version is stored in:

- `VERSION`
- `server/package.json`
- `web/package.json`
- `CHANGELOG.md`

## Release Candidate Gate

Before tagging a release:

1. Confirm every P1-P14 task in `docs/AI_ITERATION_PLAN.md` is `Done`.
2. Run `scripts/commercial-smoke.sh`.
3. Complete `docs/SECURITY_RELEASE_CHECKLIST.md`.
4. Confirm `CHANGELOG.md` includes the target version.
5. Confirm operator docs include install, upgrade, backup/restore, user workflow, troubleshooting, and release gate paths.

## Commercial Readiness Evidence

For `1.0.0`, the required evidence is:

- P1-P14 task status count has zero open tasks after P14-03 is marked `Done`.
- `scripts/commercial-smoke.sh` exits 0.
- `docs/SECURITY_RELEASE_CHECKLIST.md` exists and includes security, secrets, dangerous tools, backup, documentation, preflight, and limitations sections.
