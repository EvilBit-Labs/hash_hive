# Residual Review Findings — issue #160

**Branch:** `160-featoperator-console-implement-login-page-project-selection-ui-phase-1-step-611`
**Head:** `f44d7c5`
**Review run:** `20260527-220426-53590818` (autofix mode, 10 reviewers)
**Verdict:** Ready with fixes — all #160 ACs covered, 2 safe_auto fixes applied; 14 findings remain.

This file durably records the residual review findings from the autofix pass. When a PR is opened for this branch, the same content is intended to live in the PR body under `## Residual Review Findings`.

## Applied (safe_auto, 2) — already in commit `f44d7c5`

- **#6 [P2]** `packages/frontend/src/hooks/use-select-project.ts` — Import `SelectProjectRequest` from `@hashhive/shared` per AGENTS.md wire-shape rule. Cross-reviewer agreement (project-standards + api-contract).
- **#13 [P3]** `packages/frontend/src/hooks/use-logout.ts` — Trim 4-line mechanics-only comment on `void navigate()`. (maintainability)

## Residual

### P1 — High (5)

- **#1** `[P1][manual]` `packages/frontend/src/components/features/sidebar.tsx:92-100` — Sidebar `useSelectProject` called with no `onError` callback. Mutation failures produce no toast/log; UI state drifts from server state. Add an `onError` callback that surfaces via toast or inline banner. (reliability, c75)
- **#2** `[P1][gated_auto]` `packages/frontend/src/hooks/use-select-project.ts:38` + `sidebar.tsx` — Rapid sidebar switching can desync UI scope from server scope. Three POSTs in flight; last-write-wins server but client cache can end up with project B's data under project C's key. Fix: disable the dropdown while `selectProject.isPending`, or treat the POST response's echoed `projectId` as authoritative rather than the request value. (adversarial, c75)
- **#3** `[P1][manual]` `packages/frontend/src/pages/login.tsx:55-77` — `LoginPage.onSubmit` has no error handling for `fetchProjects()` rejection. A failed `/me` call leaves the user staring at the form with no feedback. Add a `try/catch` around `fetchProjects()` that calls `setError(...)`. (reliability, c80)
- **#4** `[P1][manual]` `packages/frontend/tests/stores/ui.test.ts:42-72` — `useUiStore` persist tests verify localStorage writes but never rehydration from a fresh store. The load-bearing "remember next login" contract is unverified end-to-end. Add a test that pre-seeds `localStorage['hashhive.ui.v1']` and asserts a fresh hook reads back the persisted values. (testing, c80)
- **#5** `[P1][manual]` `packages/frontend/e2e/smoke.spec.ts:19-26` (impact of `e2e/setup/seed-data.ts`) — Smoke e2e always hits the multi-project selector branch now that seed has 2 projects. Single-project auto-select happy path lost all e2e coverage. Either seed a second user with one membership and add an e2e for that user, or parameterize seed-data to vary by test file. (testing, c90)

### P2 — Moderate (8)

- **#7** `[P2][manual]` `packages/frontend/src/hooks/use-logout.ts:20-26` — `useLogout` swallows `signOut()` errors with no log. Orphan server session possible; visibility matters for diagnosing recurring transient logouts. Add `console.error` in the catch. **4-reviewer agreement** (correctness + reliability + project-standards + adversarial), promoted to confidence 75.
- **#8** `[P2][manual]` `packages/frontend/src/hooks/use-select-project.ts:36-39` — `qc.invalidateQueries()` with no filter is coarse, races with in-flight requests, and triggers thundering-herd refetch on rapid switching. Tag project-scoped query keys and invalidate by predicate. **4-reviewer agreement** (correctness + maintainability + reliability + adversarial), promoted to confidence 100.
- **#9** `[P2][manual]` `packages/frontend/tests/components/sidebar.test.tsx:39-83` — Sidebar `useSelectProject` mutation-failure path not tested. Silent-failure UX is undefined and unverified. Add a 4xx case mirroring the selector page's error test. (testing, c80)
- **#10** `[P2][manual]` `packages/frontend/tests/hooks/use-logout.test.tsx:52-87` — Call-order test asserts exact `['signOut','clearAuth']` order via shared mock side-effect. Brittle to intentional refactors. Loosen to assert final state and the `navigate('/login', {replace:true})` invocation, not the strict sequence. (testing, c75)
- **#11** `[P2][manual]` `packages/frontend/src/stores/ui.ts` — `useUiStore` mixes persisted UX prefs (`rememberLastProject`, `lastProjectId`, `sidebarOpen`) with server-mirrored scope (`selectedProjectId`) and ephemeral UI (`mobileSidebarOpen`). Split into `useUiPrefsStore` (persisted) + `useUiSessionStore` (in-memory). Eliminates the `partialize` whitelist as the only thing keeping server state out of localStorage. (maintainability, c75)
- **#12** `[P2][manual]` `packages/frontend/src/pages/login.tsx` — `LoginPage.onSubmit` now carries three concerns (signIn, fetchProjects, remember-last fast-path) with cross-store `getState()` coupling. Extract a `useRestoreLastProject` hook. (maintainability, c75)
- **#14** `[P2][gated_auto]` `packages/frontend/src/components/features/sidebar.tsx:104-127` — "All Projects" dropdown option is a silent no-op. Falsely implies global scope is achievable when the server requires a concrete `projectId`. Remove the option entirely or replace with a disabled placeholder. (correctness, c80)

### P3 — Low (2)

- **#15** `[P3][manual]` `packages/frontend/src/stores/ui.ts` — `persist` middleware silently falls back to in-memory when localStorage is unavailable (private browsing, quota exceeded). Breaks remember-last with no signal. Detect via `onRehydrateStorage` callback and surface a one-time console.warn. (adversarial, c75)
- **#16** `[P3][manual]` `packages/frontend/e2e/select-project.spec.ts:17-34` — `waitForURL('/')` followed by immediate `aside` assertion is racy under lazy-loaded chunks. Lacks explicit `waitForResponse` after the `waitForRequest` capture. (adversarial + reliability, c75)

## Coverage notes

- 11 findings suppressed by confidence gate (<75): 4 at anchor 50, 2 at anchor 60, 3 at anchor 65, 2 at anchor 70.
- Mode-aware demotion: 0 (testing findings were classified as `manual` not `advisory`).
- Validator pass (Stage 5b): skipped — autofix mode does not run independent validation.
- 10/10 reviewers returned. No failures.

## Past learnings flagged (ce-learnings-researcher)

Three prior docs in `docs/solutions/` applied to this work:
- `conventions/bun-test-mock-module-import-order.md` — new tests correctly follow Pattern A.
- `conventions/shared-zod-openapi-wire-contract-mirror-2026-05-25.md` — basis for the applied fix #6.
- `conventions/form-submit-payload-null-checks-2026-05-19.md` — remember-last code correctly uses `!= null`.

Researcher recommends capturing future learnings via `/ce-compound` on: BetterAuth client gotchas, Zustand persist hydration timing, TanStack `invalidateQueries` cancellation, and WS reconnect coordination with project switches — none have prior solutions docs.

## Run artifact

`/tmp/compound-engineering/ce-code-review/20260527-220426-53590818/`
