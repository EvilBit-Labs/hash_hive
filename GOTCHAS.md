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

- **`app.onError()` must check `instanceof HTTPException`** before returning a generic 500 — without this, auth middleware 401 responses get swallowed into 500s:

  ```typescript
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // ... generic error handling
  });
  ```

## Drizzle ORM

- **`db.execute(sql`...`)` returns array-like result** — access rows as `result[0]`, not `result.rows[0]`
- **No native `FOR UPDATE SKIP LOCKED`** — use raw `db.execute(sql`...`)` with a CTE for atomic claim patterns
- **Never use `sql.raw()` for agent/user-supplied values** — use Drizzle's parameterized `${value}` in tagged templates. Arrays like `${[1,2,3]}::int[]` are bound safely. `sql.raw()` is only for static SQL fragments (table/column names).

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
