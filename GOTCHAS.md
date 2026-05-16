# GOTCHAS.md

Hard-won lessons, edge cases, and "watch out for" patterns. Organized by domain.

Read the relevant section before working in that area. See also [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## TypeScript Strict Mode

- **`exactOptionalPropertyTypes`**: Use `...(val ? { key: val } : {})` spread, never `key: val ?? undefined`
- **`noUncheckedIndexedAccess`**: All `arr[i]` returns `T | undefined` — guard with null check before use
- **`noPropertyAccessFromIndexSignature`**: Use `obj['key']` bracket notation for index signatures
- **Biome `useLiteralKeys: "off"`**: MUST stay off — conflicts with `noPropertyAccessFromIndexSignature`
- **`z.preprocess` + React Hook Form**: `z.preprocess` widens input type to `unknown`, breaking `zodResolver` under strict mode. Define the form type as an explicit interface (not `z.infer`) and cast: `zodResolver(schema) as unknown as Resolver<FormType>`

## Hono

- **Dashboard sub-resource routes need ownership checks**: `requireProjectAccess()` only verifies the user is a member of the project specified in the `X-Project-Id` header -- it does NOT verify the requested resource (e.g., agent) belongs to that project. Always fetch the parent resource and check `resource.projectId === currentUser.projectId` before returning sub-resource data (benchmarks, errors, etc.).

- **`app.onError()` must check `instanceof HTTPException`** before returning a generic 500 — without this, auth middleware 401 responses get swallowed into 500s:

  ```typescript
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // ... generic error handling
  });
  ```

- **Streaming upload routes must skip body-parsing middleware**: `c.req.raw.body` is a `ReadableStream` consumed on first read. Any middleware that calls `c.req.json()`, `c.req.parseBody()`, or `c.req.arrayBuffer()` consumes it — downstream handlers get nothing. Separate streaming endpoints into their own route group without `zValidator`.

- **Never leak internal errors to clients**: The global `app.onError()` handler must NOT send `err.message` in any environment (including dev) — Drizzle errors include full SQL queries with table names and column names. Always return a generic message and log the full error server-side.

- **Use `Context<AppEnv>` for handler/helper signatures, never `Parameters<typeof Hono.prototype.get>[1]`**: The `Parameters<...>` form fails under TS strict mode (`Property 'get' does not exist on type 'never'`). Import `Context` from `hono` directly: `function helper(c: Context<AppEnv>)`.

- **Zod v3 vs v4 at the `@hono/zod-validator` hook boundary**: v0.7 emits `$ZodError` (zod v4 core) on validation failure, but local helpers like `mapZodError` are typed against `z.ZodError` from zod v3. Runtime `issues[]` shape matches; cast through `unknown` (`mapZodError(result.error as z.ZodError)`) at the hook boundary, not at every call site.

## Drizzle ORM

- **`db.execute(sql`...`)` returns array-like result** — access rows as `result[0]`, not `result.rows[0]`
- **No native `FOR UPDATE SKIP LOCKED`** — use raw `db.execute(sql`...`)` with a CTE for atomic claim patterns
- **Never use `sql.raw()` for agent/user-supplied values** — use Drizzle's parameterized `${value}` in tagged templates. Arrays like `${[1,2,3]}::int[]` are bound safely. `sql.raw()` is only for static SQL fragments (table/column names).
- **`onConflictDoUpdate` uses `excluded` with snake_case**: In `set:` clauses, reference the PostgreSQL `excluded` pseudo-table using snake_case DB column names (e.g., `` sql`excluded.speed_hs` ``), not Drizzle's camelCase field names (`speedHs`).
- **`onConflictDoUpdate` + duplicate rows in VALUES**: PostgreSQL rejects a single INSERT when the VALUES list contains multiple rows targeting the same conflict key (e.g., two entries with the same `(agentId, hashcatMode)`). Deduplicate input arrays before calling `.insert().values().onConflictDoUpdate()`, or validate uniqueness at the schema level.
- **Migration drift bundling**: `drizzle-kit generate` diffs current `schema.ts` against the last migration snapshot — if prior schema changes were never migrated, they silently bundle into the next migration. Review generated `.sql` files for unexpected ALTER statements before committing.
- **Scoping a polluted migration**: To isolate only intended changes: (1) backup `schema.ts`, (2) temporarily revert unrelated schema changes, (3) delete the migration SQL + snapshot + journal entry, (4) run `drizzle-kit generate`, (5) restore `schema.ts` from backup.
- **Atomic status guards**: Never read-then-write agent/task status in separate queries -- fold the guard into the `UPDATE WHERE` clause (e.g., `` sql`${agents.status} != 'busy'` ``) to prevent race conditions.
- **Campaign progress uses SQL aggregation**: Use `COUNT(*) FILTER (WHERE status IN (...))` and `SUM(...) FILTER (WHERE status = 'running')` instead of loading all tasks into memory. Clamp keyspace progress with `GREATEST(0, LEAST(..., 1))`.
- **Attack keyspaces must round-trip as strings, not numbers**: `attacks.keyspace varchar(255)` is sized for bigint values - mask attacks routinely exceed `Number.MAX_SAFE_INTEGER` (e.g. `?a^12` ~ 5.4e23). `Number.parseInt(keyspace)` silently loses precision above 2^53. Use `BigInt(keyspace)` for arithmetic and stringify before persisting to jsonb. Reference: `packages/backend/src/services/keyspace.ts` for the canonical bigint-string boundary. The same applies to `tasks.workRange` start/end/total fields when an attack's keyspace overflows the JS-safe range; see `jsonSafeBigint` in `packages/backend/src/services/tasks.ts`.

## Authentication (BetterAuth)

- **~~JWT custom claims may return as strings~~**: RESOLVED -- migrated from jose JWTs to BetterAuth database-backed sessions (#126). The JWT claim type coercion bug no longer applies.
- **BetterAuth returns `user.id` as string**: Even when the `users` table uses `serial` (integer) IDs, BetterAuth's `getSession()` returns `user.id` as a string. Always use `Number(session.user.id)` when bridging to the `currentUser` context.
- **Project selection is client-side**: `projectId` is sent via `X-Project-Id` header on each request, not embedded in the session. RBAC middleware reads from this header. The frontend Zustand `useUiStore.selectedProjectId` is the source of truth.
- **Cookie name is `hh.session_token`**: BetterAuth uses `cookiePrefix: 'hh'` which produces `hh.session_token` as the cookie name. Old `session` cookies from the JWT era are cleaned up by the `requireSession` middleware.

## Bun Runtime

- **`Bun.serve()` idle timeout defaults to 10s** — large uploads on slow connections will timeout. Set `idleTimeout: 120` in the server config for upload-heavy services.

## BullMQ

- **Queue names cannot contain `:`** (BullMQ 5.67+) — colons conflict with the Redis key separator. Use hyphens: `tasks-high`, `jobs-hash-list-parsing`.

## Service Layer

- **Circular import: `campaigns.ts` ↔ `tasks.ts`** — resolved via dynamic `await import('./tasks.js')` and a `_deps` injection object in `campaigns.ts`. Maintain this pattern when adding cross-service calls.
- **`_deps` injection pattern**: `campaigns.ts` exports a mutable `_deps` object for dynamic imports. Production code calls `_deps.getTasksModule()` instead of `import('./tasks.js')` directly. Tests override `_deps` properties to inject spies — this bypasses bun:test's shared module cache.

## Backend Testing (bun:test)

**Mock Module Fundamentals:**

- **`mock.module()` before `await import()`**: Mock dependencies before dynamically importing the module under test — used for service tests that need DB/queue mocks
- **Shared module cache gotcha**: `mock.module` **merges** mock exports into the real module's ESM namespace — non-mocked exports pass through, but mocked ones (e.g., `resolveGenerationStrategy: mock()`) silently replace the real function for ALL test files in the same run. Never mock individual exports of a module unless every consumer in every test file can tolerate the mock.
- **Flaky module cache**: Tests relying on `mock.module` can pass in isolation but fail in the full suite non-deterministically. If a test fails in `bun --filter @hashhive/backend test` but passes alone, re-run the full suite once before debugging — bun's module evaluation order across files is not guaranteed.
- **Separate test files for conflicting mocks**: If a module is already imported at top level in one test file (e.g., `resolveGenerationStrategy` in `campaigns.test.ts`), tests needing full module mocks for the same source must go in a separate test file to avoid import-order conflicts.
- **Isolated-phase pattern for files needing exclusive `mock.module` ownership**: `mock.module` runs at module load (before `describe.skip` can suppress it) and persists process-wide. Wrap the entire file body in `if (IS_ISOLATED) { ... }` and use `require('../../src/...')` inside to defer ESM resolution past the mocks. Gate via env var (e.g. `CONTROL_RBAC_TEST_ISOLATED=1`) wired through `package.json`'s test script as a separate phase. Existing examples: `tasks.test.ts`, `queue-manager.test.ts`, `control-routes-rbac.test.ts`.
- **Re-export the real implementation when you must mock siblings but want to preserve one export**: If a route test mocks a whole module but another test file in the same run exercises one of that module's exports for real behavior (e.g., a pure comparator), `import` the real export at the top of the route test and re-export it from the `mock.module` factory rather than inlining a degraded stub. The static import resolves to the real binding before `mock.module` hoists, so the factory can re-publish the genuine function — the process-global leak still happens, but it now installs the real implementation everywhere instead of the stub. Diagnostic signature when this is missing: a test passes locally but fails on Linux CI with a value the real function cannot produce (test-file load order differs between platforms). Canonical example: `crackers-routes.test.ts` re-exports `compareCrackerVersions` so `crackers.test.ts` still sees the real impl when both run in the same `bun test` process. **Symmetric rule:** when a test fails only on CI with a value disconnected from the implementation, search for `mock.module` calls on the affected module before rewriting the implementation — three commits of regex-rewriting on the parser could have been zero if Attempt 1 had run `grep -rn 'mock\.module.*<file>' tests/` first.

**Mock Patterns:**

- **Use `mockReset()` not `mockClear()` in `beforeEach`**: `mockClear()` only resets call history — queued `mockResolvedValueOnce` values can leak across tests, especially in CI where test execution order differs. Always follow `mockReset()` with `mockImplementation()` to restore the default return value.
- **Drizzle mock chains** must match production code — e.g. `insert().values()` returning `{ onConflictDoNothing: mock() }`
- **BullMQ worker test mocks**: if worker does `db.select()`, mock must return chainable `{ from: mock(() => chain), where: mock(() => Promise.resolve([])) }`
- **Route-level contract tests**: When mocking for `import { app }`, mock ALL transitive service dependencies (e.g., `tasks.js`, `events.js`). **Avoid** mocking modules that other test files import un-mocked (e.g., don't mock `campaigns.js` in `agent-api-contract.test.ts` — it leaks `resolveGenerationStrategy: mock()` into `campaign-transition.test.ts`). Instead, mock the leaf dependency (`tasks.js`) to break the import chain.

**Infrastructure:**

- Backend contract tests validate auth (401), validation (400), and camelCase response shapes (200) without a running DB
- Test fixtures: `packages/backend/tests/fixtures.ts` — factory functions + token helpers
- Biome overrides: `**/scripts/**` disables `noConsole` and `noExplicitAny` for CLI tools

## Frontend Testing

**Environment:**

- Frontend tests use `happy-dom` with manual global injection (not `@happy-dom/global-registrator`)
- Always call `afterEach(cleanup)` in Testing Library tests — DOM persists in happy-dom
- `@testing-library/user-event` is NOT installed — use `fireEvent` from `@testing-library/react`
- **Run tests per-package**: Use `bun --filter @hashhive/frontend test` / `bun --filter @hashhive/backend test` — root `bun test` skips per-package `bunfig.toml` (happy-dom), causing `document is not defined`

**Test Utilities:**

- `tests/mocks/fetch.ts` — `mockFetch()` replaces global fetch with route-to-response mapping; call `restoreFetch()` in afterEach
- `tests/mocks/websocket.ts` — `installMockWebSocket()` replaces global WebSocket; provides `simulateOpen/Close/Message`
- `tests/fixtures/api-responses.ts` — factory functions: `mockLoginResponse`, `mockMeResponse`, `mockDashboardStats`
- `tests/utils/store-reset.ts` — `resetAllStores()` resets all Zustand stores; call in afterEach
- `tests/test-utils.tsx` — `renderWithProviders()` (single component), `renderWithRouter()` (navigation tests), `cleanupAll()` (DOM + stores)

**Gotchas:**

- **401 intercept**: `api.ts` globally intercepts all 401 responses as "Session expired" -- tests for endpoints using the `api` wrapper must use 400 for invalid credentials to avoid triggering the interceptor. Login is exempt: it calls BetterAuth via raw `fetch` (not the `api` wrapper), so 401 from BetterAuth is correct and does not trigger the interceptor.
- **PermissionGuard hides elements**: Tests asserting on guarded elements (New Campaign link, lifecycle buttons, Upload buttons) must seed the auth store with `roles: ['admin']` or `roles: ['contributor']` via `useAuthStore.setState()` — without this, PermissionGuard renders nothing

## Frontend (JSX)

- **Unicode escapes in JSX string attributes render literally**: `message="Loading\u2026"` displays as `Loading\u2026`, not `Loading...`. JSX attribute strings are NOT JS string literals — they don't process `\uXXXX` escapes. Use the actual character or a JS expression: `message={"Loading\u2026"}`. Prefer plain ASCII (`...`, `-`) over Unicode punctuation.
- **No fancy punctuation in UI text**: Use `...` not `…`, `-` not `—`/`–`. Plain ASCII only.
- **No arbitrary pixel font sizes**: Use Tailwind's rem-based scale (`text-xs`, `text-sm`, etc.), never `text-[11px]` or similar — these don't respect user zoom preferences.
- **Tailwind v4 custom colors in `border-l-*` don't generate CSS**: Classes like `border-l-ctp-teal` using custom color tokens produce no output. Use inline `style={{ borderLeftColor: 'hsl(var(--ctp-teal))' }}` with `border-l-2` class for the width.
