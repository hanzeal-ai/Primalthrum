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

1. Confirm every P1-P24 task in `docs/AI_ITERATION_PLAN.md` is `Done`.
2. Run `scripts/commercial-smoke.sh`.
3. Complete `docs/SECURITY_RELEASE_CHECKLIST.md`.
4. Confirm `CHANGELOG.md` includes the target version.
5. Confirm operator docs include install, upgrade, backup/restore, user workflow, troubleshooting, and release gate paths.
6. Complete the requirement-by-requirement commercial audit in
   `docs/COMMERCIAL_PRODUCT_SPEC.md`.

## Commercial Readiness Evidence

The `1.0.0` evidence below proves the legacy self-hosted foundation only:

- P1-P14 task status count has zero open tasks after P14-03 is marked `Done`.
- `scripts/commercial-smoke.sh` exits 0.
- `docs/SECURITY_RELEASE_CHECKLIST.md` exists and includes security, secrets, dangerous tools, backup, documentation, preflight, and limitations sections.

It must not be used to claim mature SaaS readiness. A commercial SaaS release
also requires P15-P24, billing reconciliation, tenant isolation, website and
trial conversion, hosted Agent browser use, production infrastructure, and the
full release evidence defined in `docs/COMMERCIAL_PRODUCT_SPEC.md`.
