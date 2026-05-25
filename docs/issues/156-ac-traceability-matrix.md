# Issue #156 — AC ↔ Code ↔ Test Traceability Matrix

> Built from issue #156 (20 acceptance checkboxes across 6 blocks). Drives the verification sweep and `minio` → `object_store` rename. The companion implementation plan is local-only (`docs/plans/` is gitignored); see `docs/issues/156-object-storage-file-management-spec.md` for the durable spec.

Legend: ✅ Covered · 🟡 Partial · ❌ Orphan · ⚠️ Documented deviation · 🔧 Closed in this PR.

---

## AC 1 — S3 Client Configuration

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 1.1 | Client configured with endpoint, access key, secret key from environment variables | `packages/backend/src/config/storage.ts:26-44` (`new S3Client({ endpoint: env.S3_ENDPOINT, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }, ... })`) | `packages/backend/tests/unit/health-service.test.ts` exercises probe against env-configured client | ✅ |
| 1.2 | Bucket name sourced from `S3_BUCKET` | `config/env.ts:24-31` (Zod schema, `default('hashhive')`) consumed by every `file_ref` site | Implicit in upload/download integration tests | ✅ |
| 1.3 | Same client code works against SeaweedFS and AWS S3 with no provider-specific branches | `config/storage.ts` — only `forcePathStyle: true` flag, no branching on endpoint | n/a (provider-neutrality is a code-shape assertion) | ✅ |

---

## AC 2 — File Upload

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 2.1 | Unique object keys `{project_id}/{resource_type}/{uuid}.{ext}` | `services/resources.ts:317` (`${hl.projectId}/hash-lists/${randomUUID()}${ext}`), `:540` (`${resource.projectId}/${prefix}/${randomUUID()}${ext}`), `:663` (`${projectId}/${prefix}/${randomUUID()}` — no ext) | `packages/backend/tests/unit/resources-*.test.ts` (key construction) | 🟡 — `:663` omits `${ext}`; verify intent during U4. |
| 2.2 | `file_ref` JSONB stores `{ bucket, key, contentType, size, uploadedAt }` | `services/resources.ts:325-330`, `:548-553`, `:684-686`, `:763-768` | Multipart-upload + hash-list-parse integration tests | ✅ |
| 2.3 | Bucket in `file_ref` matches env (no hardcoded `'hashhive'`) | Every `file_ref` site reads `env.S3_BUCKET`; `rg "'hashhive'" packages/backend/src/` returns one hit at `config/env.ts:31` (Zod default — fine) | n/a (grep-verifiable) | ✅ **The ticket's "Current Implementation Issue" warning is stale** — hardcoding was already removed (likely #122 or #153). |
| 2.4 | Upload returns object metadata (bucket, key, size, content type) | `services/resources.ts:325-330` and sibling sites return the full `file_ref` shape | Integration tests | ✅ |

---

## AC 3 — Presigned URLs

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 3.1 | Presigned URLs with 1-hour expiration | `services/resources.ts → getResourcePresignedUrl` (calls `getPresignedUrl(key, 3600, ...)`); **`services/resources.ts → getAgentDownloadUrl` uses `6 * 3600`** | Storage/resource integration tests | ⚠️ — `getAgentDownloadUrl` deliberately exceeds 1h to support large-file agent downloads. Documented deviation. |
| 3.2 | URLs work against SeaweedFS and AWS S3 unchanged | `config/storage.ts:121-134` uses `@aws-sdk/s3-request-presigner` (`getSignedUrl`) — provider-neutral | n/a (provider-neutrality is a code-shape assertion) | ✅ |
| 3.3 | Content-disposition headers for downloads | `config/storage.ts:92-115` (`buildContentDisposition`) emits both `filename=` ASCII fallback + `filename*=UTF-8''<percent-encoded>` modern form; sanitizes hostile filenames | Inline unit coverage on the builder; integration test exercises real URL | ✅ |

---

## AC 4 — Health Checks

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 4.1 | Object-store connectivity check added to `/health` | `services/health.ts → executeProbes` wires the `object_store` probe via `buildDefaultProbes`; route at `routes/control/health.ts` (and dashboard equivalent) | `tests/unit/health-service.test.ts`, `tests/unit/health.test.ts` | ✅ |
| 4.2 | Health check verifies bucket exists and is accessible | `services/health.ts` — probe uses `HeadBucketCommand` against `env.S3_BUCKET` via `checkObjectStoreHealth` | `tests/unit/health-service.test.ts` (asserts connected + bucket field) | ✅ |
| 4.3 | Status (connected/disconnected); log/field names use neutral terms (`object_store`, not `minio`) | **Currently uses `minio` wire identifier** per defensive preservation in PR #153 | n/a (current code violates the AC) | 🔧 **Closed in this PR** — U2/U3 rename. |

---

## AC 5 — 12-Factor Compliance

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 5.1 | All object-store config sourced from env vars | `config/env.ts` Zod schema covers `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | Env validation tests | ✅ |
| 5.2 | No hardcoded bucket names in code | Confirmed via `rg "'hashhive'" packages/backend/src/` (one hit = the Zod default) | n/a (grep-verifiable) | ✅ |
| 5.3 | Config validated on startup (fail fast if misconfigured) | `config/env.ts:66-83` — Zod throws on parse failure; warn-once on `S3_BUCKET` falling back to default | Env-load tests | ✅ |

---

## AC 6 — Local Stack Migration

| # | AC | Production symbol | Test reference | Status |
|---|----|-------------------|----------------|--------|
| 6.1 | `docker-compose.yml` replaces `minio` with `seaweedfs` running `weed server -s3`, S3 API on port 9000 | `docker-compose.yml` — `chrislusf/seaweedfs:4.27`, ports `9000:8333` (S3 API) + `127.0.0.1:9333` (master UI) | Smoke test via `docker compose up` | ✅ |
| 6.2 | Default creds + bucket seeded on first start matching prior MinIO defaults | `docker/seaweedfs/s3-iam.json` provides `minioadmin/minioadmin`; bucket auto-created on first S3 call | `just db-seed` and integration tests work without env-var changes | ✅ **Keeping `minioadmin/minioadmin` per AC 6.2's "matching prior defaults" language.** Not renamed. |
| 6.3 | `docs/development.md` updated: drop MinIO console refs, add SeaweedFS S3-API instructions | `docs/development.md:87, 94, 104` (already mentions SeaweedFS) | n/a (doc audit in U5) | 🟡 → 🔧 U5 audit ensures no residual MinIO operational instructions remain. |
| 6.4 | `S3_ENDPOINT` default in `.env.example` / `env.ts` points at SeaweedFS; `S3_*` names retained | `.env.example:14` (`S3_ENDPOINT=http://localhost:9000`), `env.ts:24-31` (env-driven; defaults match compose) | n/a (config-verifiable) | ✅ |

---

## Pre-rename consumer audit

`rg "services\.minio|body\['minio'\]|body\.minio" packages/`:

**Backend code:**
- `services/health.ts` — owner of the field; renamed in U2.
- `tests/unit/health.test.ts`, `tests/unit/health-service.test.ts` — assertions, renamed in U2.

**Frontend code:**
- `packages/frontend/src/hooks/use-system-health.ts` — `ComponentName` type literal `'minio'` (renamed in U3).
- `packages/frontend/src/components/features/system-health-card.tsx` — label map + `COMPONENT_ORDER` (renamed in U3).

**OpenAPI:**
- `packages/openapi/control-api.yaml` — 3 refs (description + required array + properties object); renamed in U3.

**Shared:** no references.

**External consumers:** none in the repo. HashHive is pre-prod; renaming the wire field is safe.

---

## Orphans

| AC | Orphan | Closure |
|----|--------|---------|
| 2.1 | `services/resources.ts:663` omits `${ext}` from the key | U4 audit — verify intent; either fix or document. |
| 4.3 | `minio` wire identifier survives | U2 + U3 rename. |
| 6.3 | residual MinIO operational instructions in `docs/development.md` | U5 audit. |

All other AC items are either ✅ or documented deviations.
