---
date: 2026-05-31
topic: openapi-auto-generation-migration
---

# OpenAPI Auto-Generation Migration

## Summary

Stop hand-maintaining `packages/openapi/*.yaml`. Make the three OpenAPI specs (dashboard, control, agent) runtime-emitted from Hono route definitions via `@hono/zod-openapi`, with the existing `@hashhive/shared` Zod schemas as the request/response contracts inside each `createRoute(...)`. Done state: the YAML files are deleted, the spec is served per-surface as JSON, and the manual-maintenance bug class (silent drops, drift caught only after the fact by the parity test introduced in PR #183) is structurally eliminated.

MVP migrates the dashboard API and validates against the current hand-rolled `dashboard-api.yaml` at the semantic-equivalence bar (same paths, schemas, required fields, security — descriptions/examples/ordering may differ). If that passes, roll the same pattern across control and agent surfaces in the same effort.

---

## Problem Frame

Three OpenAPI specs totalling 4,234 LOC are hand-maintained today:

| Spec | LOC | Paths | Schemas |
|---|---|---|---|
| `packages/openapi/dashboard-api.yaml` | 2,386 | 44 | 50 |
| `packages/openapi/control-api.yaml` | 1,011 | 21 | 27 |
| `packages/openapi/agent-api.yaml` | 837 | 9 | 16 |

PR #181 + #183 (issue #161) shipped the dashboard read-endpoint contract that mandates a triple-sync between Zod schemas in `@hashhive/shared`, OpenAPI component schemas, and route response annotations — enforced by a structural parity test in `packages/backend/tests/unit/dashboard-api-contract.test.ts` that walks `dashboardStatsSchema._def.shape` and deep-compares against the parsed YAML.

The parity test catches drift but does not prevent it. The actual workflow today:

1. Engineer adds or changes a wire shape.
2. Engineer updates the Zod schema, the OpenAPI YAML, and the route response annotation — three places, all by hand.
3. If any of the three drifts from the other two, the contract test fails in CI.
4. Engineer iterates until green.

The PR #183 audit found two production-shipping silent-drop bugs (`busy`/`benchmarked` agents missing from counts; `cancelled` tasks missing from buckets) that the previous looser test discipline let through. The triple-sync contract closes that bug class for `/stats` but doesn't structurally prevent it elsewhere — every future hand-written component schema is a fresh chance for drift to land before the parity test catches it.

HashHive is pre-launch with no external API consumers. The cost of the manual surface is purely internal engineering toil and the silent-drop bug class — not broken downstream clients. The maintenance burden compounds with every new endpoint.

---

## Actors

- **A1. HashHive backend engineer.** Defines wire shapes in `@hashhive/shared`, writes route handlers in `packages/backend/src/routes/`. Today also writes and maintains the YAML manually. Goal: one source of truth, no duplicated declaration.
- **A2. Future generated-client consumer.** Control CLI, planned TUI, the hashcat agent project. None are deployed today; the hashcat agent project is on hold pending HashHive's own launch and has never run against this backend. The migration must keep open the door for these consumers to fetch the spec without coupling to today's exact YAML paths, but there is no live concurrent consumer the migration window has to preserve.

---

## Key Flows

- **F1. Engineer adds a new dashboard read endpoint.** Defines a Zod schema in `@hashhive/shared` (existing rule). Writes the route handler using `createRoute(...)` with that schema attached. The spec is emitted automatically at the served endpoint (e.g., `/api/v1/dashboard/openapi.json`). No YAML file is touched.
- **F2. Engineer changes a wire-shape field.** Updates the Zod schema. The change is reflected in the generated spec on the next request and in any TypeScript consumer at compile time. No coordinated YAML edit.
- **F3. A downstream client wants the spec.** Hits the per-surface generation endpoint, gets current JSON. Optionally writes it to disk via a one-shot script if a checked-in artifact is needed.

---

## Requirements

**Migration shape**

- R1. The three API surfaces (dashboard, control, agent) use `@hono/zod-openapi`'s `OpenAPIHono` + `createRoute(...)` pattern for route definition. Every route attaches its request schema (when applicable), response schema, status codes, and security scheme to the route definition.
- R2. Each surface serves its OpenAPI spec as JSON at a stable path (e.g., `/api/v1/dashboard/openapi.json`, `/api/v1/control/openapi.json`, `/api/v1/agent/openapi.json`). Path naming finalized at plan time.
- R3. Path-level prose, examples, security descriptions, and any per-status-code description blocks live in the `createRoute(...)` call — the framework's official mechanism — not in a parallel YAML file. Anything the framework does not support natively is either dropped or contributed back to the package, not replicated by a post-processing layer this repo maintains.
- R4. Wire shapes continue to live in `@hashhive/shared` as Zod schemas (AGENTS.md rule unchanged). The route definitions import and reference them; they are never re-declared inline at the route.

**MVP gate (dashboard API)**

- R5. The dashboard surface is migrated first. The runtime-generated spec is diffed against the current `packages/openapi/dashboard-api.yaml` at the **semantic equivalence** bar: every path, every method, every component schema, every required field, every status code, and every security scheme present in the hand-rolled spec is present in the generated spec. Descriptions, examples, ordering, and prose may differ.
- R6. The MVP gate is a one-time validation; the diff script is not preserved as a permanent test. Once the generated spec passes, the hand-rolled `dashboard-api.yaml` is deleted in the same change.

**Full rollout**

- R7. After the MVP passes, the control and agent surfaces are migrated to the same pattern. Each surface's hand-rolled YAML is deleted in the same change that migrates its routes.
- R8. The structural parity test in `dashboard-api-contract.test.ts` is removed (route IS the spec; structural drift is no longer possible).
- R9. AGENTS.md is updated to remove the "Keep the OpenAPI spec in sync with shared types" rule — it stops being a meaningful directive — and the dashboard read-endpoint contract doc (`docs/solutions/conventions/dashboard-read-endpoint-contract.md`) drops the OpenAPI-mirror pillar since the route is the canonical mirror.

---

## Acceptance Examples

- AE1. **Covers R1, R4, F1.** Given an engineer adding a new `GET /api/v1/dashboard/widgets` endpoint, they define `widgetsResponseSchema` in `@hashhive/shared`, wrap it in `createRoute({ method: 'get', path: '/widgets', responses: { 200: { content: { 'application/json': { schema: widgetsResponseSchema } } } } })`, and register the handler. The generated spec served at `/api/v1/dashboard/openapi.json` includes the `/widgets` path and a `WidgetsResponse` component reflecting the schema, without any YAML edit.

- AE2. **Covers R2, R3.** Given the dashboard surface serving its spec at `/api/v1/dashboard/openapi.json`, a `curl` of that endpoint returns valid OpenAPI 3.1 JSON that loads cleanly in Swagger UI and includes every path-level description, security scheme, and example contributed via `createRoute(...)` fields.

- AE3. **Covers R5 (MVP gate).** Given the migrated dashboard surface running locally, a comparison script that loads both `dashboard-api.yaml` (HEAD~) and the runtime-served spec reports zero missing paths, methods, component schemas, required fields, status codes, or security schemes. Descriptions and examples may differ; ordering may differ; the script does not flag those.

- AE4. **Covers R6, R7.** When the MVP gate passes, the same commit that lands the migrated dashboard routes also deletes `packages/openapi/dashboard-api.yaml`. The follow-on commits for control and agent each delete their YAML in the same change that migrates their routes.

- AE5. **Covers R8.** After all three surfaces are migrated, `packages/backend/tests/unit/dashboard-api-contract.test.ts` is removed. `just ci-check` remains green; the remaining test surface continues to exercise auth/membership gates and response-shape assertions via the integration tests in `dashboard-stats-routes.test.ts` (which assert Zod-schema conformance directly).

- AE6. **Covers R9.** AGENTS.md no longer instructs engineers to "Keep the OpenAPI spec in sync with shared types," and the dashboard read-endpoint contract doc lists only three pillars (shared schema, integration test, realtime invalidation hook) — the OpenAPI pillar is absorbed into the schema pillar because they are now the same artifact.

---

## Scope Boundaries

### In scope

- All three API surfaces (dashboard, control, agent) migrated to `@hono/zod-openapi`.
- Per-surface OpenAPI JSON served at a stable endpoint.
- Deletion of `packages/openapi/*.yaml` and the parity test.
- AGENTS.md + contract doc updates.

### Deferred to follow-up work

- **Swagger UI / Redoc serving.** A `@hono/swagger-ui` mount on each surface would be a small, high-value addition. Not required for the migration to succeed; pick up as a polish PR once the spec is being generated.
- **Checked-in generated JSON artifacts.** If a future consumer (the hashcat agent project's regen step, a Control CLI codegen) wants the spec checked in, add a one-shot script that writes the runtime output to a known path. Defer until a consumer asks.
- **Spec validation in CI.** A workflow step that boots the backend, fetches each surface's JSON, and runs `@redocly/cli lint` or equivalent. Useful but not blocking; layer in after the migration lands.
- **Shared description/example registry.** If the route-by-route `description:` field on `createRoute(...)` produces too much per-route prose to maintain, extract a registry. Defer until the burden is observed in practice.

### Outside this work's identity

- Building generated TypeScript / Go / Python client packages. Out of scope until an actual consumer is ready to depend on one.
- Spec-first workflows (designing endpoints in YAML before writing code). Explicitly rejected — the whole point of this migration is route-first.
- Migration to a non-Hono framework. The `@hono/zod-openapi` choice presumes Hono stays the API framework.

---

## Key Decisions

- **D1. Route-first, not schema-registry.** `@hono/zod-openapi` makes the route handler the single source of truth. The schemas-only alternative (`@asteasolutions/zod-to-openapi`) was considered and rejected because it leaves path metadata hand-maintained — half-solving the problem this brainstorm exists to close.
- **D2. Semantic equivalence is the MVP gate, not byte-near identity.** Pre-launch with no external consumers, the cost of preserving exact hand-written prose is higher than the value of preserving it. Anything the framework supports natively (descriptions, examples) carries forward; ordering and whitespace do not.
- **D3. Per-surface spec endpoints.** Each of the three API surfaces serves its own `/openapi.json` rather than a combined spec. Matches today's three-file layout and the distinct error envelopes / security schemes per surface; avoids the surface-mixing footgun where a Control API consumer accidentally pulls in dashboard-only types.
- **D4. Delete the YAML files in the same commit that migrates each surface.** No transition period where both exist; no possibility of one source of truth quietly going stale. The contract is binary per surface. Safe at this stage because no live consumer depends on a checked-in YAML file existing at a known path — the hashcat agent project is on hold and has never run against this backend.
- **D5. Delete the parity test on full rollout.** It exists to catch drift between hand-written YAML and the Zod schema. When the YAML is generated from the schema, drift is impossible by construction; the test becomes a tautology.
- **D6. Prose / examples / descriptions use the framework's official mechanism, not a parallel layer.** If `createRoute(...)` doesn't support some piece of YAML metadata we currently use, that piece is dropped or upstreamed — this repo does not add a post-processing layer to retrofit lost features.

---

## Dependencies

- **`@hono/zod-openapi`** — official Hono extension. Verify compatibility with `zod@4.4.3` (per `packages/backend/package.json`) before committing the dependency at plan time. If incompatible, this brainstorm's recommendation needs revisiting.
- **`@hono/swagger-ui`** — optional, deferred per Scope Boundaries; same compatibility check applies if adopted.
- **`@hashhive/shared`** Zod schemas — already the source of truth for wire shapes; no changes required from this brainstorm.
- **Issue #161 / PR #183 contract** — this work supersedes the OpenAPI pillar of the dashboard read-endpoint contract by making it structurally automatic. The contract doc and AGENTS.md edits in R9 are the cleanup.

---

## Open Questions

- **Q1. Does `@hono/zod-openapi` support every OpenAPI 3.1 feature we use today?** Examples: `oneOf` / `discriminator` patterns, `$ref` to shared error responses (`AuthRequired`, `Forbidden`), per-response-code `code` enum narrowing. Verify during planning; if any are unsupported, decide per-feature whether to drop, work around, or upstream a fix.
- **Q2. Where do the spec endpoints sit relative to auth?** The generated `openapi.json` is metadata, not data — operators behind a login probably shouldn't need a session to fetch it (it ships with the running app anyway). But the path is under `/api/v1/dashboard/*` today, which the cookie session middleware guards. Decide at plan time whether to mount the spec route outside the session middleware (clean) or accept that fetching the spec requires login (matches the rest of the surface).

---

## References

- **Parent contract:** `docs/solutions/conventions/dashboard-read-endpoint-contract.md` (the OpenAPI pillar that becomes redundant after this migration)
- **Parent convention:** `docs/solutions/conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md` (the triple-sync convention this migration supersedes)
- **AGENTS.md** — "Wire shapes live in `@hashhive/shared`" (unchanged) and "Keep the OpenAPI spec in sync with shared types" (removed by R9)
- **PR #183** (issue #161) — the parity test (`dashboard-api-contract.test.ts`) that this migration retires
- **Current implementation surface:** `packages/openapi/*.yaml` (deleted on full rollout), `packages/backend/src/routes/{agent,dashboard,control}/*.ts` (migrated to `OpenAPIHono` + `createRoute`), `packages/backend/src/index.ts` (mount changes)
- **`@hono/zod-openapi`** — https://hono.dev/examples/zod-openapi
- **`@hono/swagger-ui`** — https://hono.dev/examples/swagger-ui
