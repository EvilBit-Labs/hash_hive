---
module: packages/backend/tests
date: 2026-05-25
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Writing a bun:test file that mocks a collaborator module the system-under-test imports"
  - "Top-of-file `import` statements pull in code that transitively imports the module you want to mock"
  - "Authoring contract tests, WebSocket auth tests, or any service test that stubs a dependency"
  - "Tempted to call `mock.module()` inside `it()` or `beforeEach`"
related_components:
  - development_workflow
tags:
  - bun-test
  - esm-hoisting
  - mock-module
  - test-isolation
  - contract-tests
---

# Bun test `mock.module()` import-order trap and two resolution patterns

## Context

ESM `import` declarations are hoisted to the top of the module regardless of where they appear in source order. Bun's `mock.module()` replaces an entry in the module cache, but if a static `import { app } from '../../src/index.js'` sits at the top of a test file, the route handler's transitive dependencies are evaluated **before** any `mock.module()` call placed later in the file (whether inside `it()`, `beforeEach`, or even later top-level statements). The handler captures the original module references at load time, so a late mock is a no-op.

The failure mode is silent: the test still passes — sometimes by coincidence, sometimes because the assertion doesn't actually exercise the path the mock was meant to control — and a real bug in the route can ship under cover of a green test.

**Concrete instance from PR #173:** In `packages/backend/tests/unit/dashboard-api-contract.test.ts`, the 200-success test for `POST /projects/select` called `mock.module('../../src/services/projects.js', ...)` inside the `it()` body to override `getProjectById` and `findProjectMembership`. The route's handler had already been loaded via the top-of-file `import { app }`, so `findProjectMembership` was captured at the original implementation. The inline mock had no effect. CodeRabbit caught this on the second review round; the test had been "passing" but not for the reason its author believed.

This is a recurring trap. The same hoisting interaction has surfaced multiple times in this codebase: the isolated-phase pattern in `agent-heartbeat.test.ts`, `tasks.test.ts`, `queue-manager.test.ts`, `control-routes-rbac.test.ts`, and `redis-degradation.test.ts` was developed specifically to work around it (session history). An earlier frontend encounter in `campaign-dag-view.test.tsx` had the same shape (session history). The two patterns below name and codify the existing resolutions so future test authors pick the right one deliberately.

`GOTCHAS.md` lines 77-83 already cover the underlying mechanics (`mock.module()` must run before `await import()`, the isolated-phase env-gate convention, the `await import()` refinement when SUTs use top-level await). This doc adds the **two-pattern taxonomy** and a decision rule for choosing between them.

## Guidance

Two patterns address the trap. Pick based on whether the test file needs process-level isolation.

### Pattern A — Mutable-impl variables (lightweight, same process)

Register `mock.module()` **once** at the top of the file, **before** `import { app }`. The factory closes over mutable `let` bindings declared above it. Per-test setup mutates the bindings; the route always calls through to whatever the bindings currently point at. `beforeEach`/`afterEach` reset the bindings to defaults so noise doesn't leak between tests.

Use when:
- The test file can share the bun-test process with other tests.
- You need different mock return values per `it()` for the same service function.
- You're not setting `process.env` values that the route reads at module load.

### Pattern B — Isolated-phase env gate + dynamic `await import()` (heavyweight, dedicated process)

Gate the test body behind an env var (e.g., `WS_AUTH_TEST_ISOLATED=1`). When set: call `mock.module()` first, then dynamically `await import('../../src/index.js')` inside `beforeAll`. Update `packages/backend/package.json`'s `test` script to run the file in its own bun-test process with the env var set. When unset, emit a visible skip stub so the file isn't silently dropped from a default `bun test` run.

Use when:
- The test file sets `process.env` values the route reads at module load (config flags, timeout overrides, feature gates).
- You mock broad surfaces (auth, DB clients, BetterAuth, Drizzle) and don't want those mocks leaking into other test files sharing the bun-test process.
- The SUT uses top-level await, which requires the dynamic import refinement noted in `GOTCHAS.md` line 82.

### Decision rule

| If your test... | Use |
| --- | --- |
| Only varies mock return values per `it()`, same process is fine | **Pattern A** |
| Sets `process.env` values the route reads at import time | **Pattern B** |
| Mocks auth/DB/BetterAuth and other tests would be polluted | **Pattern B** |
| Needs a fresh module cache for each phase | **Pattern B** |
| Tempted to put `mock.module()` inside `it()` or `beforeEach` | **Neither — refactor to A or B** |

## Why This Matters

The trap produces **silent false-positive test passes**. The test runs, the assertion checks something, the bar turns green — but the mock never actually applied, so the test exercises the un-mocked path. Two consequences:

1. **The test asserts nothing meaningful.** A real bug in the route logic the mock was meant to isolate ships under cover of green.
2. **The author's mental model is wrong.** They believe a particular code path is covered. It isn't. Coverage tooling can't distinguish — the line did execute, just with the original implementation, not the mock.

CodeRabbit caught the PR #173 instance on a second review round; the first round of human eyes missed it because the test was green. The pattern is easy to write and hard to spot in review — which is exactly why it deserves a named, documented resolution.

The isolated-phase pattern (B) had been in this codebase since at least May 2026 for `agent-heartbeat.test.ts` and related files (session history), but the mutable-impl pattern (A) hadn't been written down before this. Both belong in the canonical reference.

A related rule from the workspace-tooling section of `GOTCHAS.md` (auto memory) applies here: when `mock.module()` factories are registered for a real module, the factory must mirror **every export imported by any upstream consumer in the route chain**, not just the symbols the test uses directly. Dynamic `import()` resolves the full module chain, so missing exports become `undefined` and break sibling routes that import them transitively. This is why Pattern B's `mock.module('../../src/services/auth.js', ...)` factory must include stubs for `getUserApiKeyMetadata`, `issueUserApiKey`, etc., even when the WS auth test doesn't touch them directly.

## When to Apply

Reach for one of these patterns whenever any of the following are true:

- Your test imports a Hono `app` (or any module that transitively loads route handlers) statically at the top of the file **and** wants to control behavior of a service function the route calls.
- Your test needs to set `process.env` values that the route reads at module load (config flags, timeout overrides, feature gates) → **Pattern B**.
- Your test wants different mock return values per `it()` for the same service function → **Pattern A**.
- Your test mocks broad surfaces (auth, DB clients, BetterAuth, Drizzle), and you don't want those mocks leaking into other test files sharing the bun-test process → **Pattern B**.
- You're tempted to put `mock.module()` inside `it()` or `beforeEach` — that is the trap.

Do **not** apply when:

- Your test only exercises pure functions imported directly (no route layer between the test and the mocked module — `mock.module()` placement is straightforward, register once at top).
- You're stubbing a module the route loads lazily inside a request handler (rare in this codebase; static `mock.module()` before the route import still works without indirection).

## Examples

### Pattern A — Mutable-impl variables

From `packages/backend/tests/unit/dashboard-api-contract.test.ts` (PR #173):

```ts
let findProjectMembershipImpl: (
  userId: number,
  projectId: number
) => Promise<{ userId: number; projectId: number; roles: string[] } | null> = async () => null

let getProjectByIdImpl: (
  id: number
) => Promise<{ id: number; name: string; slug: string } | null> = async () => null

let updateSessionImpl: (input: unknown) => Promise<unknown> = async () => ({})

// Register ONCE at module load, before `import { app }`:
mock.module('../../src/services/auth.js', () => ({
  getUserWithProjects: async () => null,
  findProjectMembership: (userId: number, projectId: number) =>
    findProjectMembershipImpl(userId, projectId),
  // The remaining exports are imported by sibling routes that get
  // loaded when `app` is imported; stub to no-ops so the dynamic
  // import resolves without "Export named X not found" errors.
  issueUserApiKey: async () => ({ token: 'stub', metadata: { hasKey: false } }),
  revokeUserApiKey: async () => undefined,
  getUserApiKeyMetadata: async () => ({ hasKey: false }),
}))

mock.module('../../src/services/projects.js', () => ({
  getProjectById: (id: number) => getProjectByIdImpl(id),
  // Other exports referenced at module-load by the projects route. The
  // /select endpoint doesn't use them; stub to no-ops to satisfy the
  // import surface.
  getUserProjects: async () => [],
  createProject: async () => null,
  // ... etc.
}))

import { app } from '../../src/index.js'

// Reset all mutable impls to their defaults before each test. Tests
// that need a specific behavior reassign in their body and rely on
// this hook to undo. No `mock.module()` re-registration ever happens
// after this file's module load.
beforeEach(() => {
  findProjectMembershipImpl = async () => null
  getProjectByIdImpl = async () => null
  updateSessionImpl = async () => ({})
})
afterEach(() => {
  findProjectMembershipImpl = async () => null
  getProjectByIdImpl = async () => null
  updateSessionImpl = async () => ({})
})

it('should return 200 with selected project on success', async () => {
  findProjectMembershipImpl = async () => ({ userId: 1, projectId: 42, roles: ['admin'] })
  getProjectByIdImpl = async (id) => ({ id, name: 'Test Project', slug: 'test-project' })
  let updateSessionCalled = false
  updateSessionImpl = async () => {
    updateSessionCalled = true
    return { session: { projectId: 42 } }
  }

  const res = await app.request(`${DASH_BASE}/projects/select`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: 'hh.session_token=valid-session',
    },
    body: JSON.stringify({ projectId: 42 }),
  })
  expect(res.status).toBe(200)
  expect(updateSessionCalled).toBe(true)
})
```

Key points:
- `mock.module()` runs at file load, before the static `import { app }` triggers route evaluation.
- The factory closes over mutable `let` bindings, so per-test overrides flow through without re-mocking.
- `beforeEach`/`afterEach` reset to defaults so a noisy test can't leak into the next one.
- The `mock.module()` factory must export **every** symbol the upstream module exports that the route chain might import.

### Pattern B — Isolated-phase env gate + dynamic `await import()`

From `packages/backend/tests/unit/websocket-auth.test.ts` (PR #173); matches the pattern in `agent-heartbeat.test.ts`, `tasks.test.ts`, `queue-manager.test.ts`, `control-routes-rbac.test.ts`, `redis-degradation.test.ts`, `dashboard-campaigns-routes.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'

const IS_ISOLATED = process.env['WS_AUTH_TEST_ISOLATED'] === '1'

if (!IS_ISOLATED) {
  // Skip-stub. Running this file in the broader unit-test phase would
  // leak the mocked modules and the shrunk timeout into other test
  // files that share the Bun process. The package.json `test` script
  // invokes this file in its own bun-test process with the env gate
  // set; outside that phase we surface a fail-soft signal so CI
  // notices a misconfiguration instead of silently dropping the suite.
  describe('websocket-auth (skipped — runs in isolated phase)', () => {
    it('signals isolation phase is required', () => {
      console.warn(
        '[websocket-auth] skipped — set WS_AUTH_TEST_ISOLATED=1 to run.'
      )
      expect(process.env['WS_AUTH_TEST_ISOLATED']).toBeUndefined()
    })
  })
} else {
  // Shrink the WS upgrade handler's per-call timeout so hang tests
  // don't have to wait the full 10s default. Must be set before the
  // dynamic `import('../../src/index.js')` below since events.ts
  // reads it at call time.
  process.env['HH_WS_AUTH_TIMEOUT_MS'] = '250'

  mock.module('../../src/lib/auth.js', () => ({ /* ... */ }))
  mock.module('../../src/services/auth.js', () => ({ /* ... */ }))

  // Dynamic import: ESM static imports can't live inside a control
  // flow block (they're hoisted to module top regardless of position).
  // The mock.module() calls above must precede the `app` resolution,
  // so we defer the import to beforeAll.
  let app: Awaited<typeof import('../../src/index.js')>['app']
  let websocket: Awaited<typeof import('../../src/index.js')>['websocket']
  let server: ReturnType<typeof Bun.serve>

  beforeAll(async () => {
    ;({ app, websocket } = await import('../../src/index.js'))
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  })

  afterAll(() => {
    server.stop(true)
  })

  describe('WebSocket BetterAuth session authentication', () => {
    // ... tests
  })
} // end IS_ISOLATED branch
```

And in `packages/backend/package.json`'s `test` script, chain the file as its own phase:

```json
{
  "scripts": {
    "test": "TASKS_TEST_ISOLATED=1 bun test --preload ./tests/preload.ts tests/unit/tasks.test.ts && ... && WS_AUTH_TEST_ISOLATED=1 bun test --preload ./tests/preload.ts tests/unit/websocket-auth.test.ts && bun test --preload ./tests/preload.ts"
  }
}
```

Key points:
- The env gate makes isolation explicit and discoverable; `grep WS_AUTH_TEST_ISOLATED` shows every place the contract is enforced.
- The skip stub when the gate is unset prevents the file from being silently dropped from a default `bun test` run.
- Dynamic `await import()` runs **after** `mock.module()`, so the route's transitive imports see the mocks.
- All `process.env` mutations must happen before the dynamic import — events.ts reads `HH_WS_AUTH_TIMEOUT_MS` at call time, but if a value is consumed at module-load time it must be set first.

### Cautionary footnotes — approaches that didn't work

1. **Inline `mock.module()` inside `it()`.** Tests passed but for the wrong reason. The static `import { app }` had already evaluated the route file and captured the original `findProjectMembership` reference. CodeRabbit's second review pass caught the trap. This is the failure mode that motivates both patterns.

2. **Wrapping the static `import { app, websocket }` inside an `else` block.** Bun rejected with `Unexpected '{'` because ESM `import` declarations cannot live inside control-flow blocks — they're hoisted to module top unconditionally. This is why Pattern B uses dynamic `await import()` inside `beforeAll` instead of a conditional static import.

3. **Mocking only the symbols the test directly uses.** Dynamic `import()` resolves the full module chain. Sibling routes imported `getUserApiKeyMetadata`, `issueUserApiKey`, and other symbols from `../../src/services/auth.js`. Static-import + lazy route evaluation had hidden the requirement; dynamic import surfaced it. The `mock.module()` factory must mirror every export upstream consumers might import.

4. **(session history)** Calling `require()` inside the `mock.module()` factory to pull in a real module value (e.g., `const { sql } = require('drizzle-orm')`). The cleaner pattern is a top-level static ESM `import` for the real symbol, then reference it inside the factory.

## Verification

Run with the appropriate isolation:

```bash
# Pattern A files run in the main phase via just test-backend (auto memory).
just test-backend

# Pattern B files run in their own phase; verify the env gate fires:
# Without the env var, the skip stub should run and assert the gate.
bun test --preload ./tests/preload.ts tests/unit/websocket-auth.test.ts
# With the env var, the real suite runs.
WS_AUTH_TEST_ISOLATED=1 bun test --preload ./tests/preload.ts tests/unit/websocket-auth.test.ts
```

`just ci-check` runs both patterns end-to-end (auto memory).

## Related

- `GOTCHAS.md` lines 77-83 — underlying mechanics of `mock.module()` ordering, isolated-phase env-gate convention, `await import()` refinement.
- `GOTCHAS.md` "Workspace tooling" section — companion rule: mock factories must mirror every export imported by upstream consumers (auto memory; session history confirmed this rule was added the same session as this doc).
- `packages/backend/tests/integration/agent-heartbeat.test.ts` — original isolated-phase precedent for Pattern B.
- `packages/backend/tests/unit/control-routes-rbac.test.ts`, `tasks.test.ts`, `queue-manager.test.ts`, `redis-degradation.test.ts`, `dashboard-campaigns-routes.test.ts` — additional Pattern B examples already in tree.
- PR #173 — the surfacing context for this doc; the two-pattern taxonomy was named there in response to a CodeRabbit re-review finding.
