# GOTCHAS.md

Hard-won lessons, edge cases, and "watch out for" patterns. Organized by domain.

Read the relevant section before working in that area. See also [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Repo Workflow

- **`docs/plans/` is gitignored** (along with `.tessl/`, `.plan/`): plan files written by `/ce-plan` and friends are local artifacts, not tracked in git. Editing them never produces a `git status` diff — don't try to commit a plan's frontmatter `status` flip. `docs/residual-review-findings/` IS tracked and is the right place for review residuals that should persist across machines.

## TypeScript Strict Mode

- **`exactOptionalPropertyTypes`**: Use `...(val ? { key: val } : {})` spread, never `key: val ?? undefined`
- **`noUncheckedIndexedAccess`**: All `arr[i]` returns `T | undefined` — guard with null check before use
- **`noPropertyAccessFromIndexSignature`**: Use `obj['key']` bracket notation for index signatures
- **Bracket access for index signatures**: `obj['key']` is required under `noPropertyAccessFromIndexSignature` — do not auto-rewrite to `obj.key`; oxlint does not flag the bracket form
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
- **Attack keyspaces round-trip with a number-or-string boundary, never as raw JS Number**: `attacks.keyspace varchar(255)` is sized for bigint values - mask attacks routinely exceed `Number.MAX_SAFE_INTEGER` (e.g. `?a^12` ~ 5.4e23). `Number.parseInt(keyspace)` silently loses precision above 2^53. Use `BigInt(keyspace)` for arithmetic; the canonical bigint-string boundary lives in `packages/backend/src/services/keyspace.ts`. For `tasks.workRange` start/end/total, use `jsonSafeBigint` in `packages/backend/src/services/tasks.ts` - it stores values as JS Number when they fit in safe-integer range and as decimal strings when they don't, so most attacks stay number-shaped and only mask-overflow chunks pay the string tax. Do NOT blindly stringify every coord; the union type `number | string` is intentional, and consumers know to coerce via `BigInt(...)` either way.

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

> Named two-pattern taxonomy + decision rule: `docs/solutions/conventions/bun-test-mock-module-import-order.md` (Pattern A: mutable-impl variables + `beforeEach` reset; Pattern B: isolated-phase env gate + `await import()`). The entries below are the underlying mechanics that motivate that taxonomy.

- **`mock.module()` before `await import()`**: Mock dependencies before dynamically importing the module under test — used for service tests that need DB/queue mocks
- **Shared module cache gotcha**: `mock.module` **merges** mock exports into the real module's ESM namespace — non-mocked exports pass through, but mocked ones (e.g., `resolveGenerationStrategy: mock()`) silently replace the real function for ALL test files in the same run. Never mock individual exports of a module unless every consumer in every test file can tolerate the mock.
- **Flaky module cache**: Tests relying on `mock.module` can pass in isolation but fail in the full suite non-deterministically. If a test fails in `bun --filter @hashhive/backend test` but passes alone, re-run the full suite once before debugging — bun's module evaluation order across files is not guaranteed.
- **Separate test files for conflicting mocks**: If a module is already imported at top level in one test file (e.g., `resolveGenerationStrategy` in `campaigns.test.ts`), tests needing full module mocks for the same source must go in a separate test file to avoid import-order conflicts.
- **Isolated-phase pattern for files needing exclusive `mock.module` ownership**: `mock.module` runs at module load (before `describe.skip` can suppress it) and persists process-wide. Wrap the entire file body in `if (IS_ISOLATED) { ... }` and use `require('../../src/...')` inside to defer ESM resolution past the mocks. Gate via env var (e.g. `CONTROL_RBAC_TEST_ISOLATED=1`) wired through `package.json`'s test script as a separate phase. Existing examples: `tasks.test.ts`, `queue-manager.test.ts`, `control-routes-rbac.test.ts`, `redis-degradation.test.ts`, `workers/metrics.test.ts`. Adding a new gate is a coordinated edit: env-gate in the test file + mocks wrapped in `if (IS_ISOLATED)` + a new `<GATE>=1 bun test --preload ./tests/preload.ts <path> &&` segment in `packages/backend/package.json` `test` script before the bare `bun test`.
- **Isolated-phase imports use `await import()`, not `require()`, for async modules**: The gotcha above mentions `require('../../src/...')` for late module resolution, but bun rejects this on modules with top-level `await` (e.g. anything that pulls in `src/index.ts`'s app graph) with `require() async module ... is unsupported. use "await import()" instead`. Use `const { app } = await import('../../src/index.js')` inside the gated branch — the test file is a module so top-level await works. Also surface the skip stub with a `console.warn` + an `expect(process.env['<GATE>']).toBeUndefined()` assertion so a CI misconfig that drops the isolated phase cannot leave the suite silently green. Canonical example: `dashboard-campaigns-routes.test.ts`.
- **Re-export the real implementation when you must mock siblings but want to preserve one export**: If a route test mocks a whole module but another test file in the same run exercises one of that module's exports for real behavior (e.g., a pure comparator), `import` the real export at the top of the route test and re-export it from the `mock.module` factory rather than inlining a degraded stub. The static import resolves to the real binding before `mock.module` hoists, so the factory can re-publish the genuine function — the process-global leak still happens, but it now installs the real implementation everywhere instead of the stub. Diagnostic signature when this is missing: a test passes locally but fails on Linux CI with a value the real function cannot produce (test-file load order differs between platforms). Canonical example: `crackers-routes.test.ts` re-exports `compareCrackerVersions` so `crackers.test.ts` still sees the real impl when both run in the same `bun test` process. **Symmetric rule:** when a test fails only on CI with a value disconnected from the implementation, search for `mock.module` calls on the affected module before rewriting the implementation — three commits of regex-rewriting on the parser could have been zero if Attempt 1 had run `grep -rn 'mock\.module.*<file>' tests/` first.

**Mock Patterns:**

- **Use `mockReset()` not `mockClear()` in `beforeEach`**: `mockClear()` only resets call history — queued `mockResolvedValueOnce` values can leak across tests, especially in CI where test execution order differs. Always follow `mockReset()` with `mockImplementation()` to restore the default return value.
- **Drizzle mock chains** must match production code — e.g. `insert().values()` returning `{ onConflictDoNothing: mock() }`
- **BullMQ worker test mocks**: if worker does `db.select()`, mock must return chainable `{ from: mock(() => chain), where: mock(() => Promise.resolve([])) }`
- **Route-level contract tests**: When mocking for `import { app }`, mock ALL transitive service dependencies (e.g., `tasks.js`, `events.js`). **Avoid** mocking modules that other test files import un-mocked (e.g., don't mock `campaigns.js` in `agent-api-contract.test.ts` — it leaks `resolveGenerationStrategy: mock()` into `campaign-transition.test.ts`). Instead, mock the leaf dependency (`tasks.js`) to break the import chain.

**Infrastructure:**

- Backend contract tests validate auth (401), validation (400), and camelCase response shapes (200) without a running DB
- Test fixtures: `packages/backend/tests/fixtures.ts` — factory functions + token helpers
- oxlint overrides (`.oxlintrc.json`): `tests/**` and `**/tests/**` relax `no-shadow`, `no-await-in-loop`, and several typescript-* rules; `scripts/**` and `packages/*/scripts/**` relax `no-await-in-loop`; `packages/frontend/e2e/**` relaxes `unicorn/consistent-function-scoping`

## Frontend Testing

**Environment:**

- Frontend tests use `happy-dom` with manual global injection (not `@happy-dom/global-registrator`)
- Always call `afterEach(cleanup)` in Testing Library tests — DOM persists in happy-dom
- `@testing-library/user-event` is NOT installed — use `fireEvent` from `@testing-library/react`
- **Run tests per-package**: Use `bun --filter @hashhive/frontend test` / `bun --filter @hashhive/backend test` — root `bun test` skips per-package `bunfig.toml` (happy-dom), causing `document is not defined`
- **Tests are NOT in the type-check scope**: `packages/{backend,frontend}/tsconfig.json` includes only `src/**/*`. `just check` / `tsc --noEmit` does not catch type errors in `tests/`. Test fixtures with missing required fields will compile and the bun runtime will accept them. When adding or refactoring shared types via `@hashhive/shared`, also update test factories/fixtures so the test data matches the wire shape — otherwise the drift only surfaces in PR review.

**Test Utilities:**

- `tests/mocks/fetch.ts` — `mockFetch()` replaces global fetch with route-to-response mapping; call `restoreFetch()` in afterEach
- `tests/mocks/websocket.ts` — `installMockWebSocket()` replaces global WebSocket; provides `simulateOpen/Close/Message`
- `tests/fixtures/api-responses.ts` — factory functions: `mockLoginResponse`, `mockMeResponse`, `mockDashboardStats`
- `tests/utils/store-reset.ts` — `resetAllStores()` resets all Zustand stores; call in afterEach
- `tests/test-utils.tsx` — `renderWithProviders()` (single component), `renderWithRouter()` (navigation tests), `cleanupAll()` (DOM + stores)

**Gotchas:**

- **401 intercept**: `api.ts` globally intercepts all 401 responses as "Session expired" -- tests for endpoints using the `api` wrapper must use 400 for invalid credentials to avoid triggering the interceptor. Login is exempt: it calls BetterAuth via raw `fetch` (not the `api` wrapper), so 401 from BetterAuth is correct and does not trigger the interceptor.
- **PermissionGuard hides elements**: Tests asserting on guarded elements (New Campaign link, lifecycle buttons, Upload buttons) must seed the auth store with `roles: ['admin']` or `roles: ['contributor']` via `useAuthStore.setState()` — without this, PermissionGuard renders nothing
- **Testing pages that use `useEvents` / `EventsProvider`**: WebSocket only opens when `authClient.useSession()` returns a session. Call `setupAuthClientMock()` then `setMockSession()` *before* the page module loads. Easiest pattern: top-level `setupAuthClientMock(); const { Page } = await import('../../src/pages/page')` — mock registration is module-load-order-sensitive. Without this, `wsMock.instances[0]` is undefined and `if (!ws) return` silently skips the test.
- **Playwright e2e tests that share a seeded user MUST use `test.describe.serial`**: every e2e in `packages/frontend/e2e/` signs in as the single seeded `test@hashhive.local`. Any test that clicks a project on `/select-project` writes `users.last_project_id`, and BetterAuth's `session.create.before` hook rehydrates `session.projectId` from that column on the next sign-in — so a follow-up test expecting `/select-project` will land on `/` and time out. CI's `workers: 1` hides this (deterministic in-file order); local `fullyParallel: true` exposes it. The fix is `test.describe.serial` with a comment naming the shared-user dependency. The same root cause is why `playwright.config.ts` excludes `demo-capture.spec.ts` from the default suite.

## Real-time Events (useEvents / EventsProvider)

- **`EventsProvider` is the singleton WebSocket owner** — mounted in `AppLayout`. `useEvents()` opens a fresh WS on every call; calling it from a page opens a duplicate connection AND duplicates the invalidation work the provider already does.
- **To refresh a query on an event, add the query key to the maps in `use-events.ts`**: `invalidationKeys` (project-scoped, invalidated as `[key, projectId]`), `agentScopedKeysByEvent` (per-agentId), `campaignScopedKeysByEvent` (per-campaignId). Do not call `useEvents({ onEvent })` from page components.
- **`EventType` union + `KNOWN_EVENT_TYPES` set derive from a single const tuple `EVENT_TYPES` in `use-events.ts`**: adding a new variant is a one-line change. The `isKnownEventType` guard drops unrecognized frames.

## Frontend (JSX)

- **Unicode escapes in JSX string attributes render literally**: `message="Loading\u2026"` displays as `Loading\u2026`, not `Loading...`. JSX attribute strings are NOT JS string literals — they don't process `\uXXXX` escapes. Use the actual character or a JS expression: `message={"Loading\u2026"}`. Prefer plain ASCII (`...`, `-`) over Unicode punctuation.
- **No fancy punctuation in UI text**: Use `...` not `…`, `-` not `—`/`–`. Plain ASCII only.
- **No arbitrary pixel font sizes**: Use Tailwind's rem-based scale (`text-xs`, `text-sm`, etc.), never `text-[11px]` or similar — these don't respect user zoom preferences.
- **Tailwind v4 custom colors in `border-l-*` don't generate CSS**: Classes like `border-l-ctp-teal` using custom color tokens produce no output. Use inline `style={{ borderLeftColor: 'hsl(var(--ctp-teal))' }}` with `border-l-2` class for the width.

## Workspace tooling

- **`bun --filter @hashhive/<pkg> test <path>` does NOT scope to one file.** It runs the package's full `test` script and ignores the path argument. To target one file, `cd packages/<pkg> && bun test --preload ./tests/setup.ts <path>`. The `--preload` is required for frontend tests (they need `window`).
- **Backend scripts must run from `packages/backend/`** — env validation reads `packages/backend/.env` relative to CWD. `bun src/scripts/seed-admin.ts` from repo root fails with "DATABASE_URL: Invalid input"; `cd packages/backend && bun src/scripts/seed-admin.ts` works.
- **Rebuild `@hashhive/shared` before backend type-check after schema or schema-types edits.** Backend imports from `dist`, not `src`. After any `packages/shared/src/schemas/*.ts` or `types/*.ts` change, run `bun --filter @hashhive/shared build` before `bun --filter @hashhive/backend type-check` or you'll get "no exported member" errors.
- **Drizzle migration SQL gets reformatted by the pre-commit hook on first commit attempt.** Both the `.sql` file and `meta/NNNN_snapshot.json` come back as "files were modified by this hook" — re-stage them and re-commit. (Path: `packages/shared/src/db/migrations/`.)
- **Tests that `mock.module('../../src/services/events.js')` must mirror every export imported by upstream consumers.** Adding a new export to `services/events.ts` that any route (e.g., `routes/dashboard/events.ts`) imports at top-level breaks ~10 test files at import time with "Export named 'X' not found." Either update every mock, or keep new constants local to the consumer file.

## Infrastructure quirks

- **`docker-compose.yml` seaweedfs healthcheck uses `localhost`** which resolves to IPv6 `::1` in the container while seaweedfs binds only to IPv4 (`127.0.0.1` + container IP). `just docker-up` fails the `bucket-init` dependency check on first start even though seaweedfs is actually healthy. Workaround: `docker run --rm --network hash_hive_default -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin amazon/aws-cli:2.27.8 --endpoint-url http://seaweedfs:8333 s3 mb s3://hashhive`. Real fix: change the healthcheck to `127.0.0.1` in `docker-compose.yml`.
