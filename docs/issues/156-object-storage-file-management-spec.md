# Technical Spec — Issue #156: Object Storage & File Management

> **Source ticket:** [`spec/tickets/Object_Storage_&_File_Management.md`](../../spec/tickets/Object_Storage_&_File_Management.md)
> **GitHub issue:** [#156](https://github.com/EvilBit-Labs/hash_hive/issues/156)
> **Track:** Phase 1 — Foundation, Step 2 of 11 (Resource Pipeline)
> **Date:** 2026-05-25

---

## 1. Issue Summary

Configure an S3-compatible object store with env-driven buckets, presigned URLs, object-store health checks, and 12-factor config — now targeting **SeaweedFS** (Apache-2.0) instead of MinIO (archived upstream + AGPL-3.0). Unblocks the Resource Management API (issue #157).

## 2. Problem Statement

Per BACKLOG.md, "Some chunked-upload code exists from #122 but AC isn't fully met." Code exploration shows the **core infrastructure swap already landed in PR #153** (commit `b4fbc5a`):

- `docker-compose.yml` runs `chrislusf/seaweedfs:4.27` with `weed server -s3`, mounting a static IAM config (`docker/seaweedfs/s3-iam.json`).
- `packages/backend/src/config/storage.ts` uses `@aws-sdk/client-s3` with `forcePathStyle: true` and explicit connect/socket timeouts (5s connect / 30s socket — bounds worker slot exposure on a hung endpoint).
- `env.S3_ENDPOINT`, `env.S3_BUCKET`, `env.S3_ACCESS_KEY`, `env.S3_SECRET_KEY`, `env.S3_REGION` are all env-driven with a startup warn-once on default fallback.
- `services/resources.ts` builds `file_ref` with `{ bucket, key, contentType, size, uploadedAt }` using `env.S3_BUCKET`.
- Object keys follow the ticket's `{project_id}/{resource_type}/{uuid}.{ext}` convention via `randomUUID()` from `node:crypto` (`services/resources.ts:317, 540, 663`).
- Presigned `GetObject` URLs are emitted via `getPresignedUrl()` with full content-disposition (`filename=` ASCII fallback + `filename*=UTF-8''` modern form).
- Chunked multipart upload (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `ListPartsCommand`) is wired.

The literal remaining work is therefore narrow: **verify the AC checklist passes against the current code, close any gaps surfaced by the verification, and reconcile the one explicit tension between the source ticket and the implementation choice in PR #153.**

### Stale guidance in the ticket

The ticket's "Technical Notes → Current Implementation Issue" section says `packages/backend/src/services/resources.ts` hard-codes `fileRef.bucket = 'hashhive'`. **This is no longer true.** Grep for the literal `'hashhive'` in `packages/backend/src/` returns exactly one hit — `env.ts:31`, the Zod default value — and every `file_ref` construction at `:325, :548, :684, :763` reads from `env.S3_BUCKET`. The hardcoding the ticket warned about has already been fixed (likely as part of #122 or #153). The verification sweep should confirm this and note it in the matrix rather than re-fixing.

## 3. The one real reconciliation: health-check field naming

**AC 4 says:** "log messages and field names use neutral terms (e.g., `object_store`, not `minio`)".

**Current code (`services/health.ts:30-36`):**
```typescript
// 'minio' is preserved as the wire identifier across the SeaweedFS swap
export type ComponentName = 'database' | 'redis' | 'minio' | 'queues'
```

PR #153 preserved `minio` as the wire identifier defensively, but **HashHive is pre-prod** — there are no external monitors reading `services.minio.*` whose contract needs honoring. The defensive preservation has outlived its usefulness; the new wire identifier should be neutral so future readers don't have to mentally translate `minio` → "actually SeaweedFS, or AWS S3 if hosted."

**Recommendation: rename `minio` → `object_store` outright.**

Concrete renames in scope:

- `ComponentName` enum literal: `'minio'` → `'object_store'` (`services/health.ts:36`).
- `ObjectStoreProbeDeps` and probe wiring: `minio` keys → `objectStore` (`services/health.ts:323, 339, 358, 375, 385, 397-398, 408`).
- Legacy envelope `services.minio.bucket` → `services.object_store.bucket` (`services/health.ts:521, 545, 548, 558-559`).
- Comments documenting the legacy contract: rewritten or removed — the back-compat note is now obsolete.
- Log fields: any `{ component: 'minio' }` log line → `{ component: 'object_store' }`.
- Shared schemas + OpenAPI exposing the health shape get the same rename in lock-step (per `docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md`).

This is a breaking change to the `/health` response shape. Mitigation: confirm during Phase A that no in-repo dashboard, agent, or CLI code reads `services.minio.*`. If a consumer exists, that consumer is updated in the same PR.

## 4. Technical Approach

Verify-first, fix-only-where-needed. Mirrors the workflow established by PR #169 / issue #155 (see `docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md`):

1. Build an AC↔code↔test matrix mapping each of the 6 AC blocks (15 checkboxes total across S3 client config, file upload, presigned URLs, health checks, 12-factor compliance, local-stack migration) to its production symbol + test.
2. For each orphan, write a failing test first; either confirm the production code is correct or fix the gap.
3. Reconcile AC 4's neutral-naming requirement via Option A above.
4. Run `just check` and `just ci-check`; both must pass.

## 5. Implementation Plan

### Phase A — AC Traceability Matrix (read-only)

The source ticket has **20 acceptance checkboxes** across 6 blocks (3 + 4 + 3 + 3 + 3 + 4). Map each to its production symbol:

1. **AC 1.1-1.3 — S3 client config** → `packages/backend/src/config/storage.ts:26-44` + `env.ts:24-31`. Verify no provider-specific branches (`forcePathStyle: true` is the only provider-flavor flag and applies to both SeaweedFS and AWS S3 path-style).
2. **AC 2.1-2.4 — file upload + `file_ref` shape** → `services/resources.ts:325-330`, `:548-553`, `:684-686`, `:763-768`. Key generation at `:317, :540, :663` uses `${projectId}/${prefix}/${randomUUID()}${ext}` (note: `:663` omits `${ext}`; verify whether that path needs an extension or is intentional).
3. **AC 3.1-3.3 — presigned URLs** → `config/storage.ts:121-134` (`getPresignedUrl`) + `services/resources.ts:573-577` (`getDownloadUrl`, 1h) + `:587-613` (`getAgentDownloadUrl`, 6h). The 6h variant exceeds the AC's 1h expiration — verify whether this is an intentional override for large-file agent downloads (likely yes) and document the deviation.
4. **AC 4.1-4.3 — health checks** → `services/health.ts:30-36`, `:323`, `:339`, `:385-408`, `:521-559`. The neutral-naming AC drives the rename in §3.
5. **AC 5.1-5.3 — 12-factor compliance** → `config/env.ts` Zod schema + `:66-83` warn-once. Verify fail-fast on missing required vars (no defaults for `S3_ACCESS_KEY` / `S3_SECRET_KEY`).
6. **AC 6.1-6.4 — local-stack migration**:
   - `6.1` SeaweedFS service in compose → `docker-compose.yml` (host port 9000 → container 8333; master UI on 9333 loopback-bound).
   - `6.2` Default credentials + bucket seeded on first start → `docker/seaweedfs/s3-iam.json` provides `minioadmin/minioadmin` matching prior MinIO defaults; bucket created via S3 API on first start. Verify `just db-seed` and integration tests work without env-var changes.
   - `6.3` `docs/development.md` updated → already mentions "SeaweedFS (S3 API)" at line 87 and the MinIO archive note at line 94. Audit for any residual MinIO console references.
   - `6.4` `.env.example` and `env.ts` defaults → `.env.example:14` sets `S3_ENDPOINT=http://localhost:9000`; `env.ts:31` defaults `S3_BUCKET=hashhive`. Existing `S3_*` names retained (provider-neutral).
7. Output the matrix to `docs/issues/156-ac-traceability-matrix.md` listing every checkbox + status.

### Side-question to settle in Phase A

The seeded credentials in `docker/seaweedfs/s3-iam.json` are `minioadmin/minioadmin` (literally — the prior MinIO defaults). These are conceptually opaque keys and AC 6.2 explicitly says "matching the prior MinIO defaults so `just db-seed` and integration tests do not need new env wiring." Either:

- **Keep** `minioadmin/minioadmin` — honors AC 6.2 verbatim; the literal is just an opaque dev secret.
- **Rename** to `hashhiveadmin/hashhiveadmin` — consistent with the broader `minio` → `object_store` rename; requires updating `.env.example`, every test fixture, `just db-seed`, and any CI env vars.

Recommend **keep** — the credential literal is not a "wire identifier" in the AC 4 sense (it's a secret, not a discoverable field name) and AC 6.2's "matching prior defaults" language was deliberate. Document the decision in the AC matrix so it does not get re-litigated.

### Phase B — Close Orphans (TDD)

Only the orphans the matrix surfaces get tests + fixes. Expected orphans based on the AC text vs. current code review:

- **AC 4 — neutral naming.** Rename `minio` → `object_store` across the `ComponentName` enum, probe deps, legacy envelope, log fields, and any shared/OpenAPI schemas that expose the shape. Update tests to assert the new field; drop the legacy `minio` field assertions.
- **AC 6.3 — `docs/development.md` updated.** Verify the doc mentions SeaweedFS S3-API; replace any lingering MinIO console references.
- **AC 6.4 — `S3_ENDPOINT` default in `.env.example`.** Verify the default matches the SeaweedFS compose service.

Before the AC 4 rename, grep the repo for any consumer reading `services.minio.*`:

```bash
rg "services\.minio|body\['minio'\]|body\.minio" packages/
```

If a consumer exists (frontend hook, agent code, CLI), update it in the same PR. If none exists (the expected outcome for a pre-prod repo), the rename is a clean drop-replace.

Anything else the matrix flags gets the same TDD pattern: failing test → fix → re-run.

### Phase C — Validation Gates

1. `just check` (format + lint + type-check + build)
2. `just ci-check` (full test suite)
3. Manual smoke: `docker compose up seaweedfs`, `bun --filter @hashhive/backend test -- storage` to confirm the local stack still works end-to-end.

## 6. Test Plan

TDD per `~/.claude/rules/testing.md`. Each AC checkbox that becomes an orphan gets a failing test before any production change.

### Unit (bun:test, backend)

- `getPresignedUrl` — emits both `filename=` ASCII fallback and `filename*=UTF-8''` modern form when a filename is provided; emits neither when omitted.
- `getPresignedUrl` — sanitizes hostile filenames (control chars, path-traversal sequences) before they hit the header.
- `file_ref` shape — `bucket` field reads from `env.S3_BUCKET`, never hardcoded `'hashhive'` literal at any call site.
- Env validation — startup fails fast when `S3_ACCESS_KEY` / `S3_SECRET_KEY` are absent; warn-once fires when `S3_BUCKET` falls back to the default.

### Integration

- Object-store health probe — `HeadBucketCommand` succeeds against the SeaweedFS compose service; failure surfaces as `status: 'disconnected'` with bucket detail.
- Multipart upload round-trip — `CreateMultipartUpload` → `UploadPart` × N → `CompleteMultipartUpload` succeeds; partial upload + `AbortMultipartUpload` cleans up.
- Presigned URL fetch — agent retrieves the file via the presigned URL with content-disposition honored by SeaweedFS.

### Contract / health envelope

- `GET /health` response — `services.object_store.status` field present (new); `services.minio.bucket` field preserved verbatim (legacy contract from #109).
- `services.object_store` and `services.minio` reference the same underlying probe so the two fields cannot disagree.

## 7. Files to Modify / Create

| Path | Action |
| ---- | ------ |
| `docs/issues/156-ac-traceability-matrix.md` | Create — 15-checkbox AC↔code↔test matrix |
| `packages/backend/src/services/health.ts` | Modify — rename `minio` → `object_store` across `ComponentName`, probe deps, legacy envelope, and comments |
| `packages/shared/src/schemas/index.ts` | Modify — rename `minio` → `object_store` in the health response schema |
| `packages/openapi/agent-api.yaml` / `packages/openapi/control-api.yaml` | Modify — rename in lock-step if the health shape is exposed |
| `packages/frontend/src/**` and `packages/backend/src/routes/**` | Audit and update — anything reading `services.minio.*` flips to `services.object_store.*` |
| `docs/development.md` | Modify — verify SeaweedFS S3-API instructions; drop any MinIO console refs |
| `.env.example` | Verify — `S3_ENDPOINT` default points at the SeaweedFS compose service |
| `packages/backend/tests/unit/health-service.test.ts` | Extend — assert dual `minio` + `object_store` fields |
| `packages/backend/tests/integration/storage.test.ts` | Extend if matrix surfaces gaps in multipart or presigned-URL coverage |

## 8. Success Criteria

All **20** AC checkboxes (3 + 4 + 3 + 3 + 3 + 4) close with green tests and `just ci-check` clean:

1. ✅ **S3 client config** (3) — env-driven endpoint/credentials/bucket; same client works against SeaweedFS and AWS S3; no provider-specific branches.
2. ✅ **File upload** (4) — unique `{project_id}/{resource_type}/{uuid}.{ext}` keys, `file_ref: { bucket, key, contentType, size, uploadedAt }`, bucket from env, upload returns metadata.
3. ✅ **Presigned URLs** (3) — 1h expiration (with 6h documented deviation for large-file agent downloads), provider-neutral, content-disposition headers present.
4. ⚠️ **Health checks** (3) — `minio` renamed to `object_store` across the health envelope and all consumers; no legacy field retained. **This is the real work in this PR.**
5. ✅ **12-factor compliance** (3) — all config env-driven; no hardcoded bucket; fail-fast on missing required vars.
6. ✅ **Local-stack migration** (4) — SeaweedFS in compose with S3 API on port 9000; default creds/bucket seeded via `s3-iam.json`; docs mention SeaweedFS; `.env.example` and `env.ts` defaults point at SeaweedFS.

Definition of done (per issue #156):

- `just check` green.
- `just ci-check` green.
- Cross-API-boundary types live in `@hashhive/shared`.
- OpenAPI specs updated in lock-step.

## 9. Out of Scope

- Hash list parsing logic (issue #157 — Resource Management API).
- Resource UI (Phase 1 step 9 — Resource Management UI).
- File versioning or backup strategies.
- Migration of pre-existing MinIO data (HashHive is pre-prod; the dev MinIO bucket can be re-seeded).
- AWS S3 hosted deployment validation (the contract is the S3 API; we trust SeaweedFS's S3-compatibility claim).

## 10. Risks & Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Rename misses an in-repo consumer of `services.minio.*` | Phase A grep sweep (`rg "services\.minio\|body\['minio'\]\|body\.minio"`) catches consumers before the rename lands; CI type-check + tests catch any missed call site. |
| SeaweedFS multipart upload behaves subtly differently from AWS S3 on edge cases (part size, ETag format) | Run integration tests against the local compose stack; AWS S3 is out of scope for this sweep. |
| `docker/seaweedfs/s3-iam.json` IAM config drift across dev / CI | The compose file mounts the file from the repo; any drift is a commit-time signal. |

## 11. Open Questions

- Is `/health` exposed via an OpenAPI surface that agent or dashboard clients consume? If yes, the rename propagates through `packages/openapi/*.yaml` and `@hashhive/shared` in lock-step per the wire-contract convention. If no (internal-only surface), the rename stays within the backend.
- Is there value in adding a SeaweedFS-specific smoke test that exercises the `weed shell` provisioning flow? Likely out of scope (compose-service correctness is verified by `docker compose up && just check`).
