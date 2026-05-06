# Residual Review Findings — Cracker Binary Management

**Branch:** `94-p0-cracker-binary-management-agent-auto-update`
**Original review HEAD:** `9c4b767`
**Resolution HEAD:** see latest commit on this branch
**Run:** `/tmp/compound-engineering/ce-code-review/20260505-094000-cracker-review/`

The autofix-mode review surfaced six residual findings on commit
`9c4b767`. A follow-up multi-agent PR review surfaced eighteen more.
**All twenty-four findings have been resolved on this branch** — this
file documents the resolution for review traceability.

## Resolved findings

### Critical

- **[P0] Concurrent multipart upload race** — `uploadCrackerChunkPart` and
  `completeCrackerChunkedUpload` now validate the caller's `s3UploadId`
  against the row's stored upload session and throw
  `CrackerUploadIdMismatchError` (HTTP 409) on mismatch.
  `initiateCrackerChunkedUpload` rejects re-initiation while a session is
  in progress.
- **[P0] partNumber accepts non-integer values** — the PUT route now
  enforces `Number.isInteger(partNumber) && 1 ≤ partNumber ≤ 10000` and
  returns 400 with a typed `VALIDATION_ERROR` for garbage values.
- **[P0] Modal orphans DB row on upload failure** — `CrackerUploadModal`
  now rolls the binary row back via `useDeleteCrackerBinary` when either
  the direct or chunked upload mutation rejects, so retries do not hit
  409 from composite uniqueness.

### High

- **[P1] PATCH/DELETE/upload routes had no try-catch** — every cracker
  dashboard handler now wraps its service call in try-catch with a typed
  error envelope and `logger.error`.
- **[P1] Mutation hooks had no `onError`** — `useCreateCrackerBinary`,
  `useUpdateCrackerBinary`, `useDeleteCrackerBinary`,
  `useUploadCrackerFile`, and the new `useUploadCrackerChunked` all take
  an optional `onError` callback. The crackers page wires it to a
  page-level `ErrorBanner`.
- **[P1] `deleteCrackerBinary` swallowed S3 failures** — the service now
  attempts S3 deletion BEFORE the DB delete and returns a
  `'storage_failed'` outcome on failure. The route maps that outcome to
  HTTP 502 with a typed error code so the admin sees an actionable
  message instead of a false success.
- **[P1] `abortCrackerChunkedUpload` left stale `s3UploadId` in DB** —
  the abort path now clears `fileRef` regardless of S3 outcome so future
  uploads can resume cleanly.
- **[P1] `AgentCapabilities` index signature defeated type safety** —
  removed the `[key: string]: unknown` escape hatch. JSONB tolerates
  extras at runtime; typos like `caps.engine` are now compile errors.
- **[P1] Frontend `CrackerBinary` drifted from `SelectCrackerBinary`** —
  derived from shared via
  `Omit<SelectCrackerBinary, 'createdAt'|'updatedAt'> & { createdAt: string; updatedAt: string }`.
  Schema column additions now surface as type errors in the frontend.
- **[P1] `window.confirm` for destructive admin op** — replaced with a
  reusable `ConfirmDialog` component in
  `components/ui/confirm-dialog.tsx`. Used by the cracker page for
  delete; available for future destructive flows.

### Medium

- **[P2] 409 detection by string matching** — replaced with
  `isUniqueViolation`, which matches the typed Postgres error code
  `23505`.
- **[P2] Direct upload had no file-size cap** — the route now caps
  Content-Length AND `file.size` at 100 MB and returns 413
  `PAYLOAD_TOO_LARGE` with a hint to use chunked uploads.
- **[P2] Chunked upload UI was deferred** — the `useUploadCrackerChunked`
  hook drives the multipart `/upload/initiate` → PUT part → `/complete`
  flow and the `CrackerUploadModal` routes files above 100 MB through
  it. Aborts on failure are best-effort.
- **[P2] Discriminated union for check-update response** —
  `crackerCheckUpdateResponseSchema` is now a `z.discriminatedUnion` on
  `updateAvailable`, so `{updateAvailable: true}` without a URL no
  longer type-checks.
- **[P2] `compareCrackerVersions` deviates from semver** — renamed in
  spirit (the function is documented as hashcat-aware, not strict
  semver) and the file-header comment now spells out the deliberate
  deviation: `6.2.6+125` is sorted AFTER `6.2.6` because hashcat tags
  betas that way.
- **[P2] `completeCrackerChunkedUpload` could persist `size: undefined`**
  — the function now requires `Number.isFinite(fileRef.fileSize)` and
  the discriminated `CrackerFileRef` union forces `fileSize` to be
  present at compile time on the `'uploading'` state.

### Low / Suggestions

- **[P3] Engine + platform are stringly typed end-to-end** — added
  `KNOWN_ENGINES = ['hashcat', 'john']` and `KNOWN_PLATFORMS = [...]`
  with derived `engineNameSchema` / `platformNameSchema`. Dashboard
  create requires the enum; agent route still accepts any string and
  logs a warn when unknown. Brings end-to-end consistency without
  breaking the agent contract.
- **[P3] `normalizeEngineName` had no direct tests** — extracted +
  exported and covered with 4 dedicated tests.
- **[P3] Agent route reimplemented `normalizeEngineName` inline** — now
  delegates to the service helper.
- **[P3] Unknown-engine returned silent success** — agent route logs
  warn with both raw and normalized engine values so misconfigured
  agents are findable in logs.
- **[P3] `agents.crackerVersion` `@deprecated` lacked tracking link** —
  the doc comment now references issue #94 explicitly.
- **[P3] Project-scoped admin gate on global resource** — documented in
  the PR description as deliberate, not a bug.
- **[P3] formatPrimaryEngine with empty version** — now trims and
  collapses to bare engine name when version is empty/whitespace.
- **[P3] Cracker dashboard CrackerFileRef as bag of optionals** —
  replaced with a discriminated union (`'pending' | 'uploading' |
  'completed'`) keyed by which fields are present. Lifecycle states are
  now compile-checked.

### R7 — test coverage

The original review's finding #1 (DB-bound paths uncovered) has been
addressed:

- 19 service-layer unit tests in `crackers.test.ts`:
  comparator, `normalizeEngineName`, `isKnownEngine`,
  `isUniqueViolation`, and the `getLatestCracker` sort-order regression
  guard.
- 14 route-layer contract tests in `crackers-routes.test.ts`: auth gates
  (admin vs viewer), validation (engine/platform enum, non-integer
  partNumber, partNumber range), Content-Length size cap, agent
  check-update auth + unknown-engine + normalized-engine echo.
- 4 hook-layer tests in `use-crackers.test.tsx`: `onError` invocation
  for create / update / delete / upload paths.
- 5 ConfirmDialog component tests.

Total: 42 new tests across 4 new files, all passing.
