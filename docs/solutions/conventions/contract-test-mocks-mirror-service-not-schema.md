---
module: packages/backend/tests, packages/backend/src/routes
date: 2026-06-03
problem_type: convention
component: testing_framework
severity: high
related_components:
  - documentation
applies_when:
  - "Authoring or updating contract tests for OpenAPIHono routes (agent, dashboard, or control surfaces)"
  - "Mocking a service module imported by a route handler under test"
  - "Adding or renaming fields in a route's request/response zod schema"
  - "Reviewing a PR that touches both a route schema and the test that covers it"
tags:
  - contract-tests
  - openapi
  - hono
  - zod-openapi
  - mocks
  - wire-contract
  - agent-api
  - test-isolation
---

# Contract-test mocks must mirror the service, not the schema

## Context

In PR #190 (the route-as-spec OpenAPI migration), three wire-contract regressions landed in a single commit and all 595 backend tests passed. The most severe: `packages/backend/src/routes/agent/index.ts` declared the `GET /tasks/{taskId}/zaps` response as `{ taskId: number, hashes: string[] }`, but the real service `getZapsForTask` in `packages/backend/src/services/tasks/zaps.ts` returns `{ zaps: string[], hasMore: boolean } | { error: string }` (the route maps the `error` arm to a 404). The route handler does `c.json(result, 200)` and passes the service return verbatim.

The Hono context's `c.json(...)` (the call site `OpenAPIHono` routes hand off to) does **not** validate the body against the declared response schema at runtime — `@hono/zod-openapi`'s response schema is a compile-time narrowing tool only. So the wrong-schema-vs-real-shape mismatch produced no runtime error.

The contract test at `packages/backend/tests/unit/agent-api-contract.test.ts:147` (before the fix) returned `{ taskId: 1, hashes: [] }` from the `getZapsForTask` mock — matching the route schema, not the real service. So the route schema, the test mock, and the runtime response builder all agreed on the wrong shape. The test suite was green. The generated OpenAPI spec at `/api/v1/agent/openapi.json` actively lied about the wire contract, and agent codegen would have produced a Go client that silently dropped cracked hash lists.

The bug was caught only because a Correctness reviewer in a multi-agent ce-code-review pass opened the actual service implementation and compared shapes. Two sister regressions in the same PR were caught the same way: a path-param rename from `{taskId}` to `{id}` (breaks Go codegen argument names) and a 200 body change from `{acknowledged: true}` to `{acknowledged: true, retried: false}` (breaks consumers with `disallowUnknownFields`). All three rode the same triangle — route schema, test mock, runtime response builder all agreed on a wrong shape.

The historical precedent is issue #170: same test file (`agent-api-contract.test.ts`), same class of escape (contract test happy path masked a wire-contract violation). The structural enabler is documented in `GOTCHAS.md` ("Tests are NOT in the type-check scope") — test fixtures aren't type-checked against `@hashhive/shared`, so mocks can drift from the real service signature without compiler complaint.

## Guidance

Test mocks for cross-boundary contracts (route ↔ service) MUST be derived from the real implementation's return type, not from the schema under test. If the mock shape comes from the same source as the schema you're validating, you're testing the schema against itself.

Two reinforcing techniques. Both are required on any contract test that mocks a service whose return value the route passes through to `c.json(...)`:

**1. Pin the mock shape to the real service return type via `satisfies` (static fixtures).**

```ts
// Type-only import via `typeof import('...').fn` so the snippet is
// copy/paste-safe in a type-checked file. A plain `import type { fn }`
// followed by `typeof fn` won't compile — `typeof` requires a value
// symbol, and `import type` only brings the type into scope.
type GetZapsForTask = typeof import('../../src/services/tasks/zaps.js').getZapsForTask

const zapsResult = {
  zaps: ['5f4dcc3b5aa765d61d8327deb882cf99:password'],
  hasMore: false,
} satisfies Awaited<ReturnType<GetZapsForTask>>

mock.module('../../src/services/tasks.js', () => ({
  getZapsForTask: async () => zapsResult,
}))
```

`satisfies Awaited<ReturnType<GetZapsForTask>>` lifts the mock into the type-check scope of the real service. If the service signature later changes, the mock fails type-check in any tool that includes the test file — `tsc` runs covering `tests/**`, type-aware ESLint, your editor, or any CI step that widens the type-check scope.

**Important enforcement caveat:** `packages/backend/tsconfig.json` currently scopes `tsc --noEmit` to `src/**/*` (tests are excluded — documented in `GOTCHAS.md` "Tests are NOT in the type-check scope"). With the default scope, `just check` does **not** validate the `satisfies` constraint in `tests/**`. The pin is still load-bearing: editor type-checking, type-aware linters, and any future widening of the tsc scope will catch drift the moment the test file enters the type-check graph. Treat the pin as documentation-plus-future-guarantee rather than as a today-CI-enforced invariant until the test scope is widened.

**2. Type the factory body via `typeof svc` (dynamic-return mocks).**

Some test files (e.g., `control-routes-rbac.test.ts`) mock services whose return value is computed per-call from mutable test-state arrays:

```ts
// Anti-pattern — no type constraint on the factory body
mock.module('../../src/services/campaigns.js', () => ({
  getCampaignById: async (id: number) => mockCampaigns.find((c) => c.id === id) ?? null,
}))
```

The convention's static-fixture `satisfies` pattern can't apply directly here — there's no single fixture to pin. Instead, type the factory's callable shape:

```ts
// Same type-only `typeof import('...').fn` idiom — no runtime import
// and no `import type` + `typeof` foot-gun.
type GetCampaignById = typeof import('../../src/services/campaigns.js').getCampaignById

const getCampaignByIdMock: GetCampaignById = async (id) =>
  mockCampaigns.find((c) => c.id === id) ?? null

mock.module('../../src/services/campaigns.js', () => ({
  getCampaignById: getCampaignByIdMock,
}))
```

This requires that the underlying `mockCampaigns` state array carries full rows satisfying the real `Awaited<ReturnType<GetCampaignById>>` shape, not a stripped-down test-fixture shape. Expanding state arrays to carry full rows is part of adopting this convention for dynamic-return tests.

**3. Add negative-shape assertions on every RED-fixed route and one representative case per YELLOW route per surface.**

```ts
const body = (await res.json()) as Record<string, unknown>
expect(body['zaps']).toBeDefined()
expect(body['hasMore']).toBe(false)
// Pin the absence of the wrong keys so a regression that re-adds them fails loudly.
expect(body['taskId']).toBeUndefined()
expect(body['hashes']).toBeUndefined()
```

The negative assertion is cheap insurance against silent regression. A YELLOW route's mock pin catches drift in the service's return type, but it does **not** catch drift in the route handler's wire synthesis (route adds a derived field the service didn't return; mock pin still passes because the service return is unchanged; wire ships the new field; OpenAPI spec doesn't declare it). Negative-shape assertions are the only guard for that class of regression.

## Why This Matters

Routes that pass service results verbatim through Hono's `c.json(...)` have **no runtime validation** between the service return value and the declared `@hono/zod-openapi` response schema. TypeScript narrowing only fires if you construct an object literal at the `c.json` call site; passing a variable typed as `unknown` or as the service return type silently widens, and the schema becomes documentation-only.

This means the OpenAPI spec — the artifact downstream clients are generated from — can diverge from reality without any test catching it, as long as the test mock agrees with the (wrong) schema. The failure mode is the worst kind: green CI, generated client compiles, runtime behavior silently drops or mistypes fields. For HashHive's agent API specifically, the consumers are out-of-process Go binaries built from the spec; a wrong schema isn't a typo, it's a wire break that ships to every deployed agent on the next codegen.

The systemic fix is to make the test mock answer to the real service, not the schema. If the schema is wrong, the contract test should fail. If the service changes, the mock should fail type-check. There should be no configuration of the three (route schema, mock, real service) where two agree and one diverges silently.

Without this convention, the only line of defense is human review reading the actual service implementation — a contingent, expensive, and unreliable safety net.

## When to Apply

Apply when all three conditions hold:

- The route handler returns a value sourced from a service or repository function (not constructed inline at the `c.json` call site).
- The endpoint is consumed by generated client code — agent API, control API, any surface where the OpenAPI spec is the contract.
- The test mocks the service module via `mock.module(...)` rather than exercising the real implementation.

This covers essentially every contract test in `packages/backend/tests/unit/*-contract.test.ts` and the route tests in `packages/backend/tests/unit/{dashboard,control,agent}-*-routes.test.ts`. Routes that build response objects inline (e.g., `c.json({ ok: true }, 200)`) get compile-time narrowing for free and don't need the mock-shape technique, but the negative-shape assertion is still cheap and worth adding when the schema has optional or recently-added fields.

Skip the pattern only for routes where the service return type IS the schema source — e.g., you've already derived the route's response schema from `z.infer<typeof serviceReturnSchema>` and the service is implemented to return that exact type. In that case the three artifacts are mechanically linked and can't drift.

## Examples

**Broken (what PR #190 shipped before review):**

`packages/backend/src/routes/agent/index.ts`:

```ts
const zapResponseSchema = z
  .object({ taskId: z.number(), hashes: z.array(z.string()) })
  .passthrough()
```

`packages/backend/tests/unit/agent-api-contract.test.ts:147`:

```ts
mock.module('../../src/services/tasks.js', () => ({
  getZapsForTask: async () => ({ taskId: 1, hashes: [] }),
}))
```

Real service in `packages/backend/src/services/tasks/zaps.ts`:

```ts
export async function getZapsForTask(
  ...
): Promise<{ zaps: string[]; hasMore: boolean } | { error: string }> {
  // ...
  return { zaps, hasMore }
}
```

The discriminated union is the safety net — the route's `'error' in result`
branch handles the failure case, and the test fixture below pins the success
variant. A `satisfies` pin against the full union keeps both branches
honest as the service evolves.

595 tests pass. The OpenAPI spec advertises `{ taskId, hashes }`. The agent receives `{ zaps, hasMore }`. The Go client drops both fields.

**Fixed:**

Route schema corrected to match the service:

```ts
const zapResponseSchema = z.object({
  zaps: z.array(z.string()),
  hasMore: z.boolean(),
})
```

Test mock pinned to the real return type (using `typeof import(...).fn`
so the snippet is copy/paste-safe in a type-checked file):

```ts
type GetZapsForTask = typeof import('../../src/services/tasks/zaps.js').getZapsForTask

const zapsResult = {
  zaps: ['5f4dcc3b5aa765d61d8327deb882cf99:password'],
  hasMore: false,
} satisfies Awaited<ReturnType<GetZapsForTask>>

mock.module('../../src/services/tasks.js', () => ({
  getZapsForTask: async () => zapsResult,
}))
```

Test asserts both positive shape and negative absence:

```ts
const body = (await res.json()) as Record<string, unknown>
expect(body['zaps']).toEqual(['5f4dcc3b5aa765d61d8327deb882cf99:password'])
expect(body['hasMore']).toBe(false)
expect(body['taskId']).toBeUndefined()
expect(body['hashes']).toBeUndefined()
```

Now any of three independent edits will fail the test:

- changing the route schema without updating the service → test fails on real shape mismatch
- changing the service return shape without updating the mock → fails at `satisfies`
- re-adding `taskId`/`hashes` to the response → fails the negative assertions

The three artifacts can no longer agree on a wrong shape.

## Anti-patterns

**Do NOT extract a `fixtureSatisfying<T>(value)` helper.** A function-parameter `value: Awaited<ReturnType<TFn>>` widens the input to the union at the call boundary — exactly the widening `satisfies` exists to prevent. The helper structurally cannot preserve discriminated-union narrowing for cases like `updateCampaign` returning `{kind: 'updated', ...} | {kind: 'not_found'} | {kind: 'not_draft', ...}`. Use the bare `satisfies` form at every call site; the small repetition is correct.

**Do NOT use explicit type annotations on the fixture.** `const fixture: Awaited<ReturnType<typeof svc>> = {...}` widens the fixture's literal type to the annotation — `as const` discriminants stop narrowing. Always use `satisfies`, never `:`.

## Related

- [`dashboard-read-endpoint-contract.md`](./dashboard-read-endpoint-contract.md) — sibling rule for *real* responses (round-trip through `.parse()`). This doc covers the *mocked-service* case; together they form: real responses are schema-conformant; mocked services are implementation-conformant.
- [`bun-test-mock-module-import-order.md`](./bun-test-mock-module-import-order.md) — the other half of the silent-success problem in contract tests. That one is about whether `mock.module()` takes effect; this one is about whether the mock returns the right shape once it does.
- [`projection-narrows-zrecord-wire-shape.md`](./projection-narrows-zrecord-wire-shape.md) — same family of contract-honesty failures, on the implementation side: a projection layer lying about runtime shape via `as` cast.
- [`shared-zod-openapi-wire-contract-mirror-2026-05-25.md`](./shared-zod-openapi-wire-contract-mirror-2026-05-25.md) — superseded ancestor. The surviving rule #2 ("test round-trips real response through shared schema") is the rule this doc extends to the mocked-test case.
- `GOTCHAS.md` "Tests are NOT in the type-check scope" — the structural enabler this convention compensates for procedurally.
- PR #190 (this convention's evidence base) and historical precedent issue #170 — same test file (`agent-api-contract.test.ts`), same class of bug (contract test mocked the happy path with the wrong assumption about service behavior, so a wire-contract violation shipped under a green test).
