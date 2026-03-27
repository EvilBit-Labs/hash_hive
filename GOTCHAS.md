# GOTCHAS.md

Hard-won lessons, edge cases, and "watch out for" patterns. Organized by domain.

Referenced from [AGENTS.md](AGENTS.md) — read the relevant section before working in that area.

## TypeScript Strict Mode

- **`exactOptionalPropertyTypes`**: Use `...(val ? { key: val } : {})` spread, never `key: val ?? undefined`
- **`noUncheckedIndexedAccess`**: All `arr[i]` returns `T | undefined` — guard with null check before use
- **`noPropertyAccessFromIndexSignature`**: Use `obj['key']` bracket notation for index signatures
- **Biome `useLiteralKeys: "off"`**: MUST stay off — conflicts with `noPropertyAccessFromIndexSignature`
- **`z.preprocess` + React Hook Form**: `z.preprocess` widens input type to `unknown`, breaking `zodResolver` under strict mode. Define the form type as an explicit interface (not `z.infer`) and cast: `zodResolver(schema) as unknown as Resolver<FormType>`

## Hono

- **Dashboard sub-resource routes need ownership checks**: `requireProjectAccess()` only verifies the user has a valid project in their JWT — it does NOT verify the requested resource (e.g., agent) belongs to that project. Always fetch the parent resource and check `resource.projectId === currentUser.projectId` before returning sub-resource data (benchmarks, errors, etc.).

- **`app.onError()` must check `instanceof HTTPException`** before returning a generic 500 — without this, auth middleware 401 responses get swallowed into 500s:

  ```typescript
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // ... generic error handling
  });
  ```

- **Streaming upload routes must skip body-parsing middleware**: `c.req.raw.body` is a `ReadableStream` consumed on first read. Any middleware that calls `c.req.json()`, `c.req.parseBody()`, or `c.req.arrayBuffer()` consumes it — downstream handlers get nothing. Separate streaming endpoints into their own route group without `zValidator`.

- **Never leak internal errors to clients**: The global `app.onError()` handler must NOT send `err.message` in any environment (including dev) — Drizzle errors include full SQL queries with table names and column names. Always return a generic message and log the full error server-side.

## Drizzle ORM

- **`db.execute(sql`...`)` returns array-like result** — access rows as `result[0]`, not `result.rows[0]`
- **No native `FOR UPDATE SKIP LOCKED`** — use raw `db.execute(sql`...`)` with a CTE for atomic claim patterns
- **Never use `sql.raw()` for agent/user-supplied values** — use Drizzle's parameterized `${value}` in tagged templates. Arrays like `${[1,2,3]}::int[]` are bound safely. `sql.raw()` is only for static SQL fragments (table/column names).
- **`onConflictDoUpdate` uses `excluded` with snake_case**: In `set:` clauses, reference the PostgreSQL `excluded` pseudo-table using snake_case DB column names (e.g., `` sql`excluded.speed_hs` ``), not Drizzle's camelCase field names (`speedHs`).
- **`onConflictDoUpdate` + duplicate rows in VALUES**: PostgreSQL rejects a single INSERT when the VALUES list contains multiple rows targeting the same conflict key (e.g., two entries with the same `(agentId, hashcatMode)`). Deduplicate input arrays before calling `.insert().values().onConflictDoUpdate()`, or validate uniqueness at the schema level.
- **Migration drift bundling**: `drizzle-kit generate` diffs current `schema.ts` against the last migration snapshot — if prior schema changes were never migrated, they silently bundle into the next migration. Review generated `.sql` files for unexpected ALTER statements before committing.
- **Scoping a polluted migration**: To isolate only intended changes: (1) backup `schema.ts`, (2) temporarily revert unrelated schema changes, (3) delete the migration SQL + snapshot + journal entry, (4) run `drizzle-kit generate`, (5) restore `schema.ts` from backup.

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

- **401 intercept**: `api.ts` globally intercepts all 401 responses as "Session expired" — login tests must use 400 for invalid credentials
- **PermissionGuard hides elements**: Tests asserting on guarded elements (New Campaign link, lifecycle buttons, Upload buttons) must seed the auth store with `roles: ['admin']` or `roles: ['contributor']` via `useAuthStore.setState()` — without this, PermissionGuard renders nothing

## Frontend (JSX)

- **Unicode escapes in JSX string attributes render literally**: `message="Loading\u2026"` displays as `Loading\u2026`, not `Loading...`. JSX attribute strings are NOT JS string literals — they don't process `\uXXXX` escapes. Use the actual character or a JS expression: `message={"Loading\u2026"}`. Prefer plain ASCII (`...`, `-`) over Unicode punctuation.
- **No fancy punctuation in UI text**: Use `...` not `…`, `-` not `—`/`–`. Plain ASCII only.
- **No arbitrary pixel font sizes**: Use Tailwind's rem-based scale (`text-xs`, `text-sm`, etc.), never `text-[11px]` or similar — these don't respect user zoom preferences.
