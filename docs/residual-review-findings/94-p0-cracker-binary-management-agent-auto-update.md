# Residual Review Findings — Cracker Binary Management

**Branch:** `94-p0-cracker-binary-management-agent-auto-update`
**HEAD at review time:** `9c4b767`
**Run:** `/tmp/compound-engineering/ce-code-review/20260505-094000-cracker-review/`
**Mode:** ce-code-review autofix

Code review was performed in autofix mode on commit `9c4b767`. The code is
already type-check / lint / format clean and all 132 backend + 128 frontend
tests pass, so no `safe_auto` fixes were applied. The findings below are
non-blocking residual work.

## Residual Review Findings

### Actionable

- **[P1] [packages/backend/tests/unit/crackers.test.ts:1] Service + route DB-bound paths lack contract tests (R7 partial)** — gated to downstream-resolver. Plan R7 calls for ≥80% coverage on new files. Only the pure semver comparator is unit-tested; createCrackerBinary, getLatestCracker, getCrackerDownloadUrl, dashboard CRUD, and the agent check-update happy path are covered only by smoke 401 tests. Suggested fix: add `tests/unit/crackers-service.test.ts` mocking the DB and storage modules in the same shape as `agent-api-contract.test.ts`. Cover engine lowercasing on write, getLatestCracker isActive filter + engine isolation, composite-unique error path returning 409, getCrackerDownloadUrl with and without `fileRef.key`, deleteCrackerBinary removing both row and S3 object.

- **[P2] [packages/backend/src/routes/dashboard/crackers.ts:81] 409 detection on duplicate cracker binary uses fragile string matching** — gated to downstream-resolver. The 409 branch fires on `message.includes('duplicate key')`. If postgres error formatting changes, this branch will mis-route. Suggested fix: replace string matching with a typed check on postgres error code `23505` (unique_violation).

- **[P2] [packages/backend/src/routes/dashboard/crackers.ts:143] Direct upload route has no explicit file-size cap** — manual to downstream-resolver. `c.req.parseBody()` is unbounded; the chunked-upload init schema caps at 500 GB but the direct path has no analogue. Suggested fix: add a 100 MB Content-Length guard returning 413 above the threshold; document the threshold as `DIRECT_UPLOAD_MAX_BYTES`.

- **[P2] [packages/frontend/src/components/features/cracker-upload-modal.tsx:1] Chunked upload UI deferred but plan U6 called for it** — manual to downstream-resolver. `useChunkedUpload` is hardcoded to `/dashboard/resources/upload/*`. Suggested fix: either generalize `useChunkedUpload` to accept a configurable resource-base path so cracker uploads can plug in, or duplicate `orchestrateUpload` for crackers. Option (a) is cleaner long-term.

### Advisory

- **[P3] [packages/shared/src/schemas/index.ts:240] Engine field on agent endpoint not whitelisted** — advisory to human. After lowercasing the value flows into a parameterized WHERE clause, so there is no exploit path; accepting unknown engine names just invites cache pollution and confusing error reports. Once JtR support actually lands, replace `z.string().min(1).optional()` with `z.enum(['hashcat', 'john']).optional()` in `crackerCheckUpdateRequestSchema` and `createCrackerBinaryRequestSchema`.

- **[P3] [packages/backend/src/routes/dashboard/crackers.ts:35] Cracker dashboard requires project context for a global resource** — advisory to human. `requireRole('admin')` routes through `checkMembership` which requires a selected project. Cracker binaries are global, so an admin must select any project they are admin of before they can manage crackers. The frontend permission check matches this end-to-end, so behavior is consistent — worth documenting in the PR description as a deliberate constraint.

## Requirements completeness (plan_source: explicit)

Plan: `docs/plans/2026-05-05-002-feat-cracker-binary-management-plan.md`

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | met | `cracker_binaries` table + composite unique index + `(engine, platform)` lookup index in migration `0004_cynical_the_order.sql` |
| R2 | met | GET / POST / PATCH / DELETE in `dashboard/crackers.ts` plus chunked init/part/complete; `requireRole('admin')` on every route |
| R3 | met | `POST /api/v1/agent/cracker/check-update` with `engine?: string` defaulting to `'hashcat'`; response shape matches plan |
| R4 | met | `AGENT_DOWNLOAD_TTL_SECONDS = 6 * 3600` in `services/crackers.ts`; mirrors `getAgentDownloadUrl` pattern |
| R5 | met | `lib/agent-capabilities.ts:getPrimaryEngine` + columns/labels in `pages/agents.tsx` and `pages/agent-detail.tsx`; falls back to `capabilities.hashcatVersion` |
| R6 | met | All new identifiers neutral: `crackerBinaries`, `getLatestCracker`, `/api/v1/dashboard/crackers`, `Permission.CRACKER_MANAGE` |
| R7 | partially addressed | 18 new unit tests + full suite pass; type-check + lint clean. DB-bound service + route paths covered only by smoke 401 tests. See finding #1. |
