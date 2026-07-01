---
module: packages/backend, packages/shared, packages/frontend
date: 2026-05-25
problem_type: convention
component: api-contract
severity: medium
tags:
  - wire-contract
  - rename
  - schema-version
  - pre-prod
  - openapi
  - back-compat
  - health-endpoint
applies_when:
  - "An earlier PR defensively preserved a placeholder wire identifier (`minio`, `legacy_*`, vendor-specific name) instead of renaming it"
  - "HashHive (or any project) is still pre-prod, with no documented external automation consumers of the affected surface"
  - "The new field name is more accurate or vendor-neutral and would reduce future cognitive load for maintainers"
  - "A subsequent PR can pay the rename cost once, atomically, with a schema-version bump"
---

# Drop placeholder wire identifiers cleanly while pre-prod, paired with a schema-version bump

## Context

PR #153 swapped HashHive's object store from MinIO to SeaweedFS but kept `minio` as the wire identifier in the `/health` envelope. The defensive preservation was explicit in the code: a comment said "`'minio'` is preserved as the wire identifier across the SeaweedFS swap so frontend consumers keep working without a coupled release." Three weeks later, issue #156 AC 4.3 mandated the neutral name (`object_store`). Two options surfaced:

- **A. Add `services.object_store` alongside `services.minio`** — dual-write, deprecate the old name later.
- **B. Rename outright, drop the legacy alias, bump the schema version.**

The instinct on shipping wire-contract changes is to favor option A. Dual-write is what you do in production. But HashHive is pre-prod — no monitors, no load-balancer probes, no SDK consumers — so the defensive preservation had no live constraint to honor. Option A would carry placeholder vendor naming forward into post-prod indefinitely; option B costs one PR.

The decision was option B. The rename landed in PR #171 alongside a `HEALTH_VERSION` bump from `1.1.0` to `2.0.0` and a matching `info.version` bump in the OpenAPI control spec, with a changelog entry documenting the break.

## Guidance

When an earlier PR's defensive back-compat preservation outlives its usefulness AND the project is genuinely pre-prod, drop it cleanly in one PR. Four moves make the change durable:

### 1. Audit consumers before deciding (cheap, evidence-based)

Run `rg "services\.minio|body\['minio'\]|body\.minio" packages/` (substitute your field name) across the repo. If the only consumers are the test files for the legacy field itself, the back-compat has no live constraint. If a frontend hook, CLI, or agent code reads the old name, the rename is still possible but must update those consumers in the same PR.

Anything outside the repo is harder to audit. Pre-prod posture means "no production consumers exist yet" — note the assumption explicitly in the PR description so a reviewer can challenge it.

### 2. Rename across the wire-shape mirror in one PR

The rename touches every corner of the contract atomically. (As of 2026-06-01 the OpenAPI surface is **route-as-spec** — the shared Zod schema bound into `createRoute(...)` IS the spec, generated at `GET /api/v1/{agent,dashboard,control}/openapi.json`; there is no `packages/openapi/*.yaml` to edit. The `*.yaml` references in this doc reflect PR #171's state, which predated that migration — see the now-superseded [wire-contract-mirror convention](shared-zod-openapi-wire-contract-mirror-2026-05-25.md).)

- Backend service code (enum types, probe wiring, log fields, comments describing current behavior).
- Backend tests (mocks, assertions, regression-guards).
- Shared schemas (`packages/shared/src/schemas/`) — if the type didn't live there already, move it now per AGENTS.md "wire shapes live in shared."
- The OpenAPI binding — the shared Zod schema referenced from the route's `createRoute(...)` definition (formerly a hand-maintained `packages/openapi/*.yaml` entry: the `required` array and `properties` map).
- Frontend hooks + components that consume the field.
- Frontend tests with fixtures (the most common miss; the type-check covers backend but a `tsconfig.json` that only `includes` `src/**/*` won't catch frontend test fixtures).

### 3. Bump the schema version with a changelog entry

```typescript
// packages/backend/src/services/health.ts
/**
 * 2.0.0 (issue #156) — `components.minio` renamed to `components.object_store`
 *   across both the rich envelope and the legacy public envelope. No
 *   back-compat alias; pre-2.0.0 probes keyed on the old name will see
 *   the field absent.
 * 1.1.0 (issue #109) — three-tier status, `components` map, per-component
 *   `message`/`detail`/`durationMs`.
 */
export const HEALTH_VERSION = '2.0.0'
```

```yaml
# packages/openapi/control-api.yaml
info:
  description: |
    ## Changelog

    ### 2.0.0 (issue #156)

    Breaking rename in `SystemHealth.components`:
    - `minio` → `object_store`. The previous key was a SeaweedFS-era
      placeholder; the neutral name is vendor-agnostic.
    - `services.minio` is removed from the legacy `/health` envelope —
      no dual-write, no alias.
    - `HEALTH_VERSION` constant bumps to `2.0.0` in lock-step.
  version: 2.0.0
```

Bumping the version is the durable signal that lets a future consumer gate on the change. Without it, the only evidence of the rename is the git history.

### 4. Add a regression guard, not just an assertion change

Mechanical assertion renames (`expect(body.services.minio)` → `expect(body.services.object_store)`) prove the new field exists. Symmetric guards prove the old name is gone:

```typescript
// Asserts the new name is present AND the old name is absent —
// reintroducing the legacy alias becomes a test failure, not a silent
// re-violation of the AC.
expect(body.services.object_store.status).toBe('connected')
expect(body.services.minio).toBeUndefined()
```

Apply this pattern on every health surface (legacy `/health`, rich `/control/health`, rich `/dashboard/health`) — pinning only the least-used one is inconsistent.

## Why This Matters

- **Pre-prod is the right window.** Once external probes, generated SDKs, or third-party monitors exist, dropping a wire identifier requires a deprecation cycle (typically two minor versions with dual-write). Pre-prod has no such constraint — the cost is one atomic PR. Post-prod, the same rename is a quarter of work.
- **Schema versions are the durable signal.** `HEALTH_VERSION` and OpenAPI `info.version` survive git-history archaeology. Consumers regenerating SDKs three months later see "2.0.0 — breaking rename" in the changelog without needing to read the diff.
- **Symmetric absence guards prevent silent re-introduction.** A future PR that "helpfully" re-adds the old field as an alias would pass mechanical assertions on the new field; only the `toBeUndefined()` guard catches it. This is the same regression-guard discipline as the `services.minio.toBeUndefined()` test landed in this PR.
- **Defensive preservation has a half-life.** PR #153's "preserve `minio` as wire identifier" comment was correct *at the time* and wrong three weeks later. Mark such preservations with their justification (PR #156's AC 4.3 cited the rename mandate) so the next maintainer can evaluate whether the constraint still holds.

## When to Apply

- A field, key, or wire identifier on a public-facing surface has placeholder vendor naming (`minio`, `aws_*`, `legacy_*`).
- The repo is pre-prod and a `rg` audit confirms no in-repo consumer reads the old name.
- The rename is part of a verification sweep or AC closure where the cleanup PR is already on the roadmap.
- The new name reduces future cognitive load (a maintainer reading `object_store` shouldn't have to mentally translate to "actually SeaweedFS, or AWS S3 if hosted").

Don't apply when:

- Production consumers exist (operator scripts, generated SDKs, third-party monitors). Use additive-then-deprecate instead.
- The "placeholder" is actually a load-bearing internal symbol — renaming would cascade through DB columns, queue names, log queries, or other infrastructure not in the same repo.
- You can't audit the consumer space. Pre-prod posture is a claim about external state; if you can't verify it, treat the rename as a production-grade contract change with dual-write.

## Examples

### The audit that decided it

```bash
$ rg "services\.minio|body\['minio'\]|body\.minio" packages/
packages/backend/src/services/health.ts: ...
packages/backend/tests/unit/health.test.ts: ...
packages/backend/tests/unit/health-service.test.ts: ...
packages/frontend/src/hooks/use-system-health.ts: ...
packages/frontend/src/components/features/system-health-card.tsx: ...
packages/openapi/control-api.yaml: ...
```

All in-repo. No external grep target. Option B was safe.

### The rename diff at a glance

| Surface | Before | After |
| ------- | ------ | ----- |
| `ComponentName` enum | `'minio'` | `'object_store'` |
| `LegacyHealthEnvelope.services.minio` | `{ status, bucket }` | (renamed to `object_store`) |
| OpenAPI `required` array | `[database, redis, minio, queues]` | `[database, redis, object_store, queues]` |
| `HEALTH_VERSION` | `'1.1.0'` | `'2.0.0'` |
| OpenAPI `info.version` | `1.1.0` | `2.0.0` |
| WS broadcast `component` field | `'minio'` | `'object_store'` |

### What stayed

```yaml
# docker/seaweedfs/s3-iam.json — left untouched.
# `minioadmin/minioadmin` is an opaque dev secret, not a wire identifier.
# AC 6.2 explicitly mandates "matching the prior MinIO defaults so
# `just db-seed` and integration tests do not need new env wiring."
identities:
  - name: hashhive-admin
    credentials:
      - accessKey: minioadmin
        secretKey: minioadmin
```

Audit your "everything has the old name" intuition. Some literals — opaque credentials, third-party SDK class names, library version strings — survive a rename because they aren't wire identifiers in the AC-text sense.

## Related

- [`shared-zod-openapi-wire-contract-mirror-2026-05-25.md`](shared-zod-openapi-wire-contract-mirror-2026-05-25.md) — the triple-sync pattern this rename followed (Zod schema + OpenAPI spec + route handler + contract test).
- **PR #153** — first half of the swap; preserved `minio` as wire identifier defensively.
- **PR #171** — second half; dropped the placeholder, bumped `HEALTH_VERSION` to 2.0.0.
- **AGENTS.md** — "Wire shapes live in `@hashhive/shared`" and "Keep the OpenAPI spec in sync with shared types."
