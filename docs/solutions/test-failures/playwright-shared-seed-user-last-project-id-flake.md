---
title: "Playwright e2e flake: shared seed user's last_project_id bypasses /select-project"
date: 2026-05-30
problem_type: test_failure
component: testing_framework
severity: high
module: frontend/e2e
symptoms:
  - "select-project.spec.ts 'multi-project login' times out waiting for /select-project and lands on / instead"
  - "Flake reproduces locally but never in GitHub CI"
  - "Failure depends on which worker picks up the spec and what other tests ran first"
  - "Earlier tests in smoke.spec.ts and select-project.spec.ts click a project, persisting users.last_project_id for the shared seed user"
  - "BetterAuth session.create.before hook rehydrates session.projectId from last_project_id on next sign-in, skipping the selector"
root_cause: test_isolation
resolution_type: config_change
related_components:
  - backend/auth-hook
  - frontend/e2e
  - playwright-config
  - betterauth-session-hook
tags:
  - playwright
  - e2e
  - test-isolation
  - flaky-test
  - betterauth
  - session-hook
  - last-project-id
  - workers-config
---

# Playwright e2e flake: shared seed user's `last_project_id` bypasses `/select-project`

## Problem

Playwright e2e tests in `packages/frontend/e2e/` intermittently failed locally on `select-project.spec.ts:7 -- "multi-project login routes through selector and POSTs /projects/select"`. The test timed out waiting for `/select-project` and landed on `/` instead. GitHub CI never saw the flake because CI already pinned `workers: 1`; only local multi-worker runs were affected. The root issue was shared-user state leakage across e2e specs, not random timing.

## Symptoms

- `select-project.spec.ts:7` times out waiting for navigation to `/select-project`, landing on `/` instead.
- Failure is non-deterministic locally — passes on rerun, never reproduces in CI.
- Stress-running the suite (4× consecutive raw e2e runs) initially appears green, masking the structural bug.
- Other specs that exercise `test@hashhive.local` (notably `smoke.spec.ts:7` and the "sidebar sign-out" test in the same file) silently mutate `users.last_project_id` as a side effect.

## What Didn't Work

- **"Re-run to confirm flake."** Passed on retry, which made it look like a Playwright timing issue rather than database state leakage. The flake mechanism is real but state-driven: order-of-execution determines whether the user already has `last_project_id` set when the test signs in.
- **`test.describe.serial` alone (first pass).** Wrapping `select-project.spec.ts` in `test.describe.serial(...)` fixed the in-file ordering between "sidebar sign-out" and "multi-project login routes through selector". Local stress-testing showed 4× green runs. But Copilot's reviewer pointed out that `describe.serial` only orders tests *within* one file. `smoke.spec.ts` line 23-24 also signs in as `test@hashhive.local` and clicks "Test Project" on `/select-project` if it lands there -- which writes `users.last_project_id`. Under multi-worker, `smoke.spec.ts` and `select-project.spec.ts` can race across files, and `describe.serial` does nothing for that.

## Solution

Two-layer fix: pin the suite to a single worker in `playwright.config.ts`, and keep the in-file `describe.serial` annotation on the shared-user block.

`packages/frontend/playwright.config.ts` -- pin workers to 1 everywhere, not just CI:

```ts
// `workers: 1` enforced everywhere, not just CI. The e2e suite shares
// a single seeded user (`test@hashhive.local`) AND shared backend
// state -- any spec that picks a project on `/select-project` writes
// `users.last_project_id`, and BetterAuth's session.create.before hook
// rehydrates `session.projectId` from that column on the next sign-in.
// With multiple workers, cross-file races produce intermittent "land
// on / instead of /select-project" timeouts that are invisible in
// CI's single-worker run. Until each spec has an isolated seeded
// user OR `last_project_id` is reset between tests, single-worker is
// the only durable answer. `fullyParallel: true` stays because it's
// the right default once state isolation is in place; it's a no-op
// while `workers: 1` is in effect.
fullyParallel: true,
forbidOnly: !!process.env['CI'],
retries: process.env['CI'] ? 2 : 0,
workers: 1,
```

`packages/frontend/e2e/select-project.spec.ts` -- keep in-file serialization:

```ts
// `serial` is the in-file half of the state-isolation answer: both
// tests sign in as `test@hashhive.local`, and the sign-out test picks
// "Test Project" -- which writes `users.last_project_id`. The
// `playwright.config.ts` `workers: 1` setting handles the cross-file
// half (smoke.spec.ts also mutates `last_project_id` via the same
// selector flow). Both halves are load-bearing until each spec has
// its own seeded user.
test.describe.serial('Multi-project select flow (issue #160)', () => {
  // ...existing tests...
})
```

`GOTCHAS.md` -- new entry under Frontend Testing: "Playwright e2e suite runs single-worker until each spec has its own seeded user."

## Why This Works

The flake is a state leak between specs, not a timing race:

1. `test@hashhive.local` is a shared seed user across the e2e suite (`packages/frontend/e2e/setup/seed-data.ts`).
2. Any spec that clicks "Test Project" on `/select-project` POSTs to `/projects/select`, which writes `users.last_project_id`.
3. BetterAuth's `session.create.before` hook in `packages/backend/src/lib/auth.ts` reads `users.last_project_id` on every sign-in and rehydrates `session.projectId`.
4. If `select-project.spec.ts`'s multi-project login test signs in after any spec has set `last_project_id`, the backend skips the selector and routes the user to `/`.

`workers: 1` eliminates *cross-file* parallel scheduling, so no other spec can mutate the row while `select-project.spec.ts` is mid-flight. `describe.serial` eliminates *in-file* parallel scheduling for the two tests that share the seed user, which is the same root cause at a smaller scope. The two layers are complementary: `serial` documents the in-file dependency at the call site for future readers; `workers: 1` defends against future specs that add new uses of the shared user.

This is also why `demo-capture.spec.ts` is excluded from the default suite — same root cause, called out in `playwright.config.ts`'s existing comment block.

## Prevention

- **`just ci-check` before push, not just `just check`.** CI runs the full e2e suite, which is where state-leak bugs surface. `just check` (format + lint + type-check + build) does not catch this class.
- **Don't relax `workers: 1` without first wiring per-spec isolation.** Same rule for dropping `describe.serial` on any block that touches `test@hashhive.local`.
- **Follow-up: per-spec seeded users.** Each spec creates its own user via the seed harness (e.g., `select-project-user@hashhive.local` distinct from `smoke-user@hashhive.local`) so no two specs share `users.last_project_id`. This is the durable answer that unlocks `fullyParallel: true` + `workers: undefined` for real.
- **Follow-up: `beforeEach` reset.** Cheaper interim: a Playwright `beforeEach` (or a backend test-only endpoint) that resets `users.last_project_id = NULL` for the shared seed user before each test in any spec that signs in as `test@hashhive.local`. Less durable than per-spec users but unblocks parallel runs sooner.
- **Audit rule.** Any new e2e spec that signs in as `test@hashhive.local` must either (a) live inside a `describe.serial` block whose first test does NOT pick a project, OR (b) reset `last_project_id` in `beforeEach`. The `GOTCHAS.md` Frontend Testing entry is the call-site reminder.

## Related

- `GOTCHAS.md` — Frontend Testing section, entry "Playwright e2e suite runs single-worker until each spec has its own seeded user". This solution doc is the deeper structured form; GOTCHAS is the quick-reference.
- `docs/plans/2026-05-26-001-feat-betterauth-project-selection-rbac-plan.md` — issue #159, introduced the `session.create.before` hook + `users.last_project_id` rehydration that is the upstream root cause.
- `docs/plans/2026-05-27-002-feat-login-project-selection-ui-plan.md` — issue #160 / PR #178, wired `POST /api/v1/dashboard/projects/select` and the selector UI that the e2e specs hit.
- `packages/frontend/playwright.config.ts` — `testIgnore` comment block explaining the same root cause for `demo-capture.spec.ts`.
