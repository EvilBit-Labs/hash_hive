# Object Storage & File Management

## Overview

Configure an S3-compatible object store (SeaweedFS) for binary artifacts (hash lists, wordlists, rulelists, masklists) with env-driven bucket configuration following 12-factor app principles. The backend uses `@aws-sdk/client-s3`, so the contract is the S3 API — the implementation is swappable.

## Implementation Choice — SeaweedFS

This ticket targets **SeaweedFS** (Apache-2.0, single-binary deploy, S3-compatible). It replaces the previous MinIO choice for two reasons:

1. **License posture.** SeaweedFS ships under Apache-2.0, which aligns with the rest of the HashHive dependency tree. MinIO is AGPL-3.0.
2. **Maintenance.** The upstream `minio/minio` repository was archived (2026-04-25) and the community-edition admin console was stripped in May 2025. SeaweedFS is actively maintained and is the consensus replacement in the OSS ecosystem (e.g., Kubeflow Pipelines adopted it as its default storage backend).

The S3 API surface this project uses (`PutObject`, `GetObject`, `HeadBucket`, presigned `GetObject` URLs) is fully covered by SeaweedFS. No backend code change is required beyond the docker-compose service swap and env-var defaults; the runtime client stays `@aws-sdk/client-s3`.

## Scope

**In Scope:**
- Configure the S3 client with env-driven endpoint, credentials, and bucket name (12-factor)
- Implement file upload with `file_ref` JSONB structure
- Generate presigned URLs for agent downloads (1-hour expiration)
- Add object-store health checks to `/health`
- Update `file_ref` schema to use env/config bucket name consistently
- Replace the `minio` docker-compose service with `seaweedfs` (S3 API mode), update dev/CI env vars and docs to match
- Update storage service in `file:packages/backend/src/services/resources.ts`

**Out of Scope:**
- Hash list parsing logic (handled in separate ticket)
- Resource management UI (handled in frontend ticket)
- File versioning or backup strategies
- Migration of any pre-existing MinIO data — HashHive is pre-prod; the dev-only MinIO bucket can be re-seeded against SeaweedFS

## Acceptance Criteria

1. **S3 Client Configuration**
   - Client configured with endpoint, access key, secret key from environment variables
   - Bucket name sourced from `S3_BUCKET` environment variable
   - Same client code works against SeaweedFS (dev / air-gapped prod) and AWS S3 (any future hosted deploy) — no provider-specific branches

2. **File Upload**
   - Files uploaded with unique object keys (e.g., `{project_id}/{resource_type}/{uuid}.{ext}`)
   - `file_ref` JSONB field stores: `{ bucket, key, contentType, size, uploadedAt }`
   - Bucket name in `file_ref` matches env/config value (no hard-coded `'hashhive'`)
   - Upload returns object metadata (bucket, key, size, content type)

3. **Presigned URLs**
   - Generate presigned URLs for agent downloads with 1-hour expiration
   - URLs work against SeaweedFS and AWS S3 unchanged
   - URLs include appropriate content-disposition headers for downloads

4. **Health Checks**
   - Object-store connectivity check added to `/health`
   - Health check verifies bucket exists and is accessible
   - Health check reports status (connected/disconnected); log messages and field names use neutral terms (e.g., `object_store`, not `minio`)

5. **12-Factor Compliance**
   - All object-store configuration sourced from environment variables
   - No hard-coded bucket names in code
   - Configuration validated on startup (fail fast if misconfigured)

6. **Local Stack Migration**
   - `docker-compose.yml` replaces the `minio` service with a `seaweedfs` service running `weed server -s3` (or equivalent), exposing the S3 API on port 9000
   - Default credentials and bucket are seeded on first start (matching the prior MinIO defaults so `just db-seed` and integration tests do not need new env wiring)
   - `docs/development.md` updated: drop MinIO console references; replace with SeaweedFS S3-API instructions and any management endpoint SeaweedFS exposes
   - `S3_ENDPOINT` default in `.env.example` / `env.ts` points at the SeaweedFS service; existing `S3_*` env-var names retained (they are already provider-neutral)

## Technical Notes

**Current Implementation Issue:**
- `file:packages/backend/src/services/resources.ts` hard-codes `fileRef.bucket = 'hashhive'`
- `file:packages/backend/src/config/storage.ts` uses `env.S3_BUCKET`
- Need to align both to use env-driven bucket name

**File Reference Structure:**
```typescript
interface FileRef {
  bucket: string;      // From env.S3_BUCKET
  key: string;         // Unique object key
  contentType: string; // MIME type
  size: number;        // File size in bytes
  uploadedAt: string;  // ISO timestamp
}
```

**Presigned URL Generation:**
```typescript
const presignedUrl = await getSignedUrl(
  s3Client,
  new GetObjectCommand({ Bucket: fileRef.bucket, Key: fileRef.key }),
  { expiresIn: 60 * 60 } // 1 hour
);
```

**SeaweedFS S3 API notes:**
- SeaweedFS speaks the S3 API but it must be explicitly enabled (`weed server -s3` or the equivalent compose flag). It listens on the standard S3 port; pointing `@aws-sdk/client-s3` at it works with `forcePathStyle: true` (same as MinIO).
- Static credentials and a default bucket can be seeded via a SeaweedFS S3 IAM config file mounted into the container; alternatively use `weed shell` to provision on first boot.

## Dependencies

None (foundation layer).

## Spec References

- `spec:f4542d0d-b9bd-4e50-b90b-9141e8063a18/9332598a-b507-42ee-8e71-6a8e43712c16` (Tech Plan → Resource Storage Architecture)
- `spec:f4542d0d-b9bd-4e50-b90b-9141e8063a18/9332598a-b507-42ee-8e71-6a8e43712c16` (Tech Plan → object-store bucket metadata decision)
- SeaweedFS S3 API documentation: <https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API>
