# Residual Review Findings — feat/resource-management-api

Source: `ce-code-review` autofix run `20260524-193353-229ef20a` against base `b4fbc5a` on branch `feat/resource-management-api` (PR pending creation).

Plan: `docs/plans/2026-05-24-001-feat-resource-management-api-plan.md`.

Reviewers dispatched: correctness, security, reliability, api-contract, testing, maintainability, project-standards, performance, kieran-typescript (9 of 9 returned).

Applied in this PR (commit `a73011f`): see commit body.

## Residual Actionable Work

### Test coverage gaps (P1)

- **P1** `packages/backend/src/routes/dashboard/resources.ts:75-184` — U5 multipart route handler has no direct tests. U8 bypasses the route and calls the worker processor directly. All validation branches, 413/503/400/404/202 status mapping, and rollback path are unverified. (`testing-001`)
- **P1** `packages/backend/src/queue/workers/hash-list-parser.ts:232-257` — Worker `failed`-listener (hash_list_failed emit + DB cleanup) has no test coverage; U8 leaves this as an explicit placeholder. First regression here leaves rows stuck in `processing` forever. (`testing-002`)
- **P1** `packages/backend/src/services/campaign-progress.ts:164-180` — `hashProgress` rename mapping silently untested: the existing mock at `campaign-resource-validation.test.ts:130` still returns the old `{total, cracked, remaining}` shape, so `stats.totalCount > 0` is always false and the new branch never executes. (`testing-003`)

### Security / reliability hardening (P1-P2)

- **P1** `packages/backend/src/routes/dashboard/resources.ts:84-134` — Multipart `POST /hash-lists` buffers the entire request body via `c.req.parseBody()` BEFORE the 10MB cap is checked inside `uploadHashListFile`. Authenticated admin/contributor can OOM the backend with a multi-GB multipart payload. Fix: apply Hono `bodyLimit(~12MB)` middleware to multipart resource routes so they 413 before `parseBody`. (`security-sec-001`)
- **P2** `packages/backend/src/queue/workers/hash-list-parser.ts:232-249` — Raw `err.message` forwarded over `resource_update` WebSocket to all project subscribers (including viewers). Exposes schema and storage internals within the project trust boundary. Fix: map errors to a sanitized enum on the wire; keep raw message in structured logs only. (`security-sec-002`)
- **P2** `packages/backend/src/services/resources.ts:274-307` — `importHashList` check-then-act race: status flips to `processing` BEFORE enqueue; the revert UPDATE is unguarded and may itself fail, leaving the row stuck. Fix: enqueue first, then flip status; or use a single status-guarded UPDATE WHERE clause. (`reliability-R6`)
- **P2** `packages/backend/src/config/storage.ts:18-26` — `S3Client` is constructed without `requestHandler` timeouts — a slow/hung S3 indefinitely blocks the worker slot and the DELETE route. Fix: add `NodeHttpHandler` with `connectionTimeout` + `socketTimeout`. (`reliability-R7`)
- **P2** `packages/backend/src/services/resources.ts:134-143,179-188` — DELETE paths trust `fileRef.bucket` from JSONB. Any future endpoint that lets a user influence `fileRef` would let DELETE target an arbitrary bucket the IAM credentials can reach. Fix: pin to `env.S3_BUCKET` on delete, validate key has no leading `/` or `..`. (`security-sec-004`)
- **P3** `packages/backend/src/config/storage.ts:62-83` — `sanitizeFilename` only strips 4 characters. User-controlled `file.name` flows into Content-Disposition headers; Unicode control / RTL override chars survive. Mitigated by `attachment;` keyword forcing download in modern browsers. Fix: use RFC 5987 `filename*=UTF-8''<percent-encoded>` and cap filename length at the API boundary (200 chars). (`security-sec-003`)

### Maintainability (P2-P3)

- **P2** `packages/backend/src/services/resources.ts:120-200` — `deleteHashList` and `deleteResource` are ~90% duplicate. Extract a shared cascade helper that accepts the table + cascade-tables list. (`maint-001`)
- **P2** `packages/backend/src/routes/dashboard/resources.ts:75-184` — `POST /hash-lists` multipart branch is a 100-line inline handler mixing 5 concerns (validation, create, upload, rollback, enqueue). Extract validation + composition into service helpers. (`maint-002`)
- **P3** `packages/backend/tests/unit/{agent-api-contract,campaign-transition,workers/heartbeat-monitor,workers/metrics}.test.ts` — `emitResourceUpdate` mocked across 4 test files. Acknowledged GOTCHA pattern; consider a shared mock factory or move events.js mocking into `tests/preload.ts`. (`maint-005`)
- **P3** `packages/backend/package.json` — 11 isolated-phase env-vars accumulating in the `test` script. Needs a sustainable indexing pattern (per-suite config, glob-discovery, or an isolated-phase manifest). (`maint-006`)
- **P3** `packages/backend/src/routes/dashboard/resources.ts` (756 lines) + `packages/backend/src/services/resources.ts` (870 lines) — Split each file into 4-5 cohesive modules: hash-lists / generic-resource-factory / chunked-upload / detect-hash-type / shared types. (`maint-008`, `maint-009`)
- **P3** `packages/openapi/dashboard-api.yaml` ResourceList response — uses generic `additionalProperties`; routes return fixed-key envelopes (`{wordlists: [...]}` etc). Split into `WordlistList` / `RulelistList` / `MasklistList` responses so generated clients get the correct property name. (`api-contract-003`, `ps-005`)

### Performance (P2-P3)

- **P2** `packages/backend/src/services/resources.ts` (deleteHashList hashItems cascade) — DELETE hash_items is a single unbounded statement. For hash lists with millions of items this can lock the table for a long time. Fix: batch in chunks (e.g. `DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 10_000)` loop). (`perf-1`)
- **P3** `packages/backend/src/queue/workers/hash-list-parser.ts` (post-parse stats) — Two separate `COUNT` queries at parse completion. One `COUNT(*) FILTER` query (like `getHashListStats`) is a single roundtrip. (`perf-4`)

### Dropped findings

- 9 findings suppressed at confidence anchor < 75 (low-confidence advisory items).
- 4 testing/maintainability advisory P2-P3 items demoted via mode-aware demotion.
