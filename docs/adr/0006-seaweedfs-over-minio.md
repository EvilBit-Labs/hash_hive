# ADR-0006: SeaweedFS over MinIO for object storage

**Date**: 2026-06-18
**Status**: accepted
**Deciders**: Project owner (@unclesp1d3r)

## Context

Recorded retroactively; the decision was made during pre-1.0 development and
is captured here so the rationale is durable. HashHive stores binary
artifacts (hash lists, wordlists, rule lists, mask lists) in an
S3-compatible object store. The original spec
(`spec/tickets/Object_Storage_&_File_Management.md`,
`spec/specs/Tech_Plan__HashHive_Architecture.md`) named MinIO. Two problems
surfaced: MinIO is AGPL-3.0, which conflicts with HashHive's Apache-2.0
dependency posture, and the upstream `minio/minio` repository was archived
(2026-04-25) with the community admin console stripped earlier in 2025.

## Decision

Use SeaweedFS (Apache-2.0) as the S3-compatible object store. The
application talks to it through `@aws-sdk/client-s3`, so the store remains
swappable behind the standard S3 client.

## Alternatives Considered

### Alternative 1: MinIO (original spec choice)

- **Pros**: ubiquitous, well-documented, the spec already targeted it.
- **Cons**: AGPL-3.0 license conflict; upstream archived; community console
  removed.
- **Why not**: the license and abandonment risk are disqualifying for a tool
  meant to ship into long-lived air-gapped deployments.

### Alternative 2: Cloud object storage (S3/GCS/R2)

- **Pros**: zero ops.
- **Why not**: HashHive's production target is an air-gapped LAN; a
  self-hosted, S3-compatible store is required.

## Consequences

### Positive

- License-clean (Apache-2.0) artifact storage with an active upstream.
- The S3 client abstraction keeps the store replaceable.

### Negative

- SeaweedFS is less widely known than MinIO; operators may need orientation.

### Risks

- The spec docs still say MinIO and are now stale; readers must treat
  ARCHITECTURE.md / this ADR as authoritative until the spec is refreshed.
