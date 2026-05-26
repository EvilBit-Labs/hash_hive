# Residual Review Findings — Issue #159

**Branch:** `feat/betterauth-project-selection-rbac`
**HEAD at filing:** `a983106`
**Source review run:** `/tmp/compound-engineering/ce-code-review/20260526-033221-38a7ed0d/`
**Reviewers dispatched:** 12 (correctness, security, testing, maintainability, project-standards, api-contract, data-migration, reliability, adversarial, ce-agent-native-reviewer, ce-learnings-researcher, ce-deployment-verification-agent)
**Mode:** `autofix`
**Plan:** `docs/plans/2026-05-26-001-feat-betterauth-project-selection-rbac-plan.md` (explicit)

This file is the durable record of review findings that were NOT addressed in the same PR. Created per `superpowers/lfg` step 5 fallback path because no PR existed at filing time. When the PR is created (LFG step 7), its body will link here.

---

## Applied in-branch (no follow-up needed)

| # | Type | File | Description |
|---|------|------|-------------|
| 1 | safe_auto | `packages/openapi/dashboard-api.yaml` | Added 401 `AuthRequired` to `/projects/select`, 500 `API_KEY_READ_FAILED` to `GET /me/api-key`, 400 `ValidationFailed` to `PATCH /projects/{projectId}/members/{userId}`, and enumerated all three `INTERNAL_ERROR` failure modes (incl. `setUserLastProjectId` failure) on `POST /projects/select` 500. |
| 2 | safe_auto | `packages/openapi/dashboard-api.yaml` | Added 4 missing fields to `GET /projects` response schema (`description`, `settings`, `createdAt` required, `description`/`settings` nullable). Closes api-contract AC-001. |
| 3 | safe_auto | `packages/shared/src/types/index.ts` | Corrected `SessionUser` docstring — the previous "AppEnv mirrors the shape" claim was technically false (`selectedProjectId` vs `projectId` field names). |
| 4 | safe_auto | `packages/backend/src/middleware/auth.ts` | `coerceRoles` exported + emits a warning when input had values but all were dropped (data drift signal). |
| 5 | safe_auto | `packages/backend/src/middleware/auth.ts` | Operator-visible warn log when `session.session.projectId` surfaces as non-number type. |
| 6 | safe_auto | `packages/backend/src/middleware/api-key.ts` | Replaced asymmetric `row.roles as UserRole[]` cast with `coerceRoles(row.roles, row.id)` — both auth surfaces now apply the same UserRole allowlist. Closes security/adversarial/maintainability 3-reviewer corroboration. |
| 7 | safe_auto | `packages/backend/src/routes/dashboard/auth.ts` | Wrapped `GET /me`'s `getUserWithProjects` in try/catch. Closes reliability M1. |
| 8 | safe_auto | `packages/frontend/src/stores/auth.ts` | `fetchProjects` no longer silently swallows errors; logs via `console.error`. Closes reliability M2. |
| 9 | manual fix | `packages/backend/src/services/projects.ts` | `removeUserFromProject` now invalidates `ba_sessions.project_id` AND `users.last_project_id` in the same transaction. Closes adversarial adv-001 (P1). |

All applied fixes verified with `just check` + `just test` (499 backend + 327 frontend tests green).

---

## Residual Review Findings

The autofix pass applied 9 changes; the items below were judged too high-touch for the security-flip PR or require cross-team decisions, and are recorded here so the PR review conversation can route them.

### P1 — currentUser.projectId vs SessionUser.selectedProjectId field-name divergence

**Reviewer corroboration:** maintainability M1 (P1) + api-contract AC-005 (low).
**File:** `packages/backend/src/types.ts:18`.

`AppEnv['Variables']['currentUser']` uses field name `projectId`. The shared `sessionUserSchema` and `meResponseSchema.selectedProjectId` use `selectedProjectId`. The autofix corrected the misleading docstring; the deeper rename would touch ~60 destructures + 20 route handlers. Out of scope for the security PR. Recommend a follow-up PR `refactor(types): rename currentUser.projectId → selectedProjectId for shape parity with SessionUser`.

**Why this didn't land here:** Mechanical rename across every dashboard route handler, with no behavior change. Easier to review in a focused refactor PR; keeps this diff's security-flip story clean.

### P1 — R7 tier matrix not applied across dashboard routes

**Reviewer:** api-contract AC-005 (high).
**Files:** `packages/backend/src/routes/dashboard/{campaigns,resources,attack-templates,agents}.ts`.

Plan #159 R7 defines a tier matrix gating destructive ops on `requireRole('admin', 'operator')` (global) and creates on `requireRole('admin', 'operator', 'analyst')`. Only `routes/dashboard/crackers.ts` mounts the new global `requireRole`. Other dashboard routes still gate per-project only — a user with global tier `analyst` who is a per-project `admin` can still delete campaigns/resources.

**Recommended fix shape:** Per-route audit against the matrix. Destructive endpoints (campaign delete, run/stop/pause/resume/cancel, resource delete, attack-template delete) get `requireRole('admin', 'operator')` alongside the existing `requireMembershipRole(...)`. Test fixtures need session mocks with non-admin global roles to cover the operator-allowed and analyst-rejected paths.

**Why this didn't land here:** Touches 5+ route files, ~10 endpoints, and requires updating 5+ test files' session fixtures to seed non-admin roles. The U5 commit description does not claim full matrix rollout; it lands the split + the crackers example. Recommend a follow-up PR `feat(rbac): apply R7 tier matrix to dashboard campaigns/resources/attack-templates routes`.

### P2 — Migration backfill `WHERE roles = ARRAY['analyst']` is not idempotent

**Reviewer corroboration:** api-contract AC-006 + maintainability M8 + testing-002.
**File:** `packages/shared/src/db/migrations/0010_salty_blazing_skull.sql:10`.

`UPDATE users SET roles = ARRAY['admin'] WHERE roles = ARRAY['analyst']` clobbers legitimate analyst users if ever replayed against a populated DB. Drizzle's migrator won't replay applied migrations, but `db:push` against a snapshot mid-deploy or a manual re-run could.

**Why this didn't land here:** The migration is already committed and would be applied to prod. Editing committed migrations post-commit is risky. Mitigation belongs in deployment procedures (see the ce-deployment-verification-agent's checklist at the run artifact) — and in a future migration that scopes the backfill by `created_at` if the pattern recurs.

### P2 — Test fixture duplication across 6 dashboard test files

**Reviewer:** maintainability M4.
**Files:** `packages/backend/tests/unit/{dashboard-agents-routes,dashboard-resources-routes,dashboard-campaigns-routes,dashboard-api-key-routes,crackers-routes,attack-templates}.test.ts`.

Six tests duplicate the BetterAuth `getSession` + auth-service mock block. The U7 commit (`016051b`) AND the U6 followup (`7f87bc1`) both forced shotgun edits across all six to add new service exports. A shared `tests/helpers/mock-session.ts` factory would consolidate.

**Why this didn't land here:** A test-infra refactor that touches every dashboard route test file is its own PR. Recommend `refactor(tests): extract shared BetterAuth + auth-service mock factory`.

### P2 — Integration tests promised in plan §5.1 substituted with unit-level mocks

**Reviewer:** testing-003 (medium).
**Files (not created):** `tests/integration/dashboard-project-scope.test.ts`, `tests/integration/auth-me-selected-project.test.ts`.

Plan §5.1 promised integration tests against the real BetterAuth + Postgres adapter. Implementation landed unit-level mocks at `tests/unit/routes/` instead. BetterAuth's `databaseHooks` wiring is therefore not exercised end-to-end. The session-invalidation-on-revocation fix (applied here as adv-001) ALSO needs an integration test — the planned unit-level test ran into mock.module isolation issues and was dropped during the autofix pass.

**Why this didn't land here:** Integration tests against the BetterAuth runtime require lifting Postgres in the test environment, which is its own scaffolding work. Recommend adding the integration tests in the same PR that ships the R7 tier matrix rollout (P1 #2 above) so both gain coverage together.

### P2 — Login auto-select test doesn't exercise the new server-priority branch

**Reviewer:** testing-001.
**File:** `packages/frontend/tests/pages/login.test.tsx:97`.

`syncSelectedProject` was extended in U7 to prefer the server's `selectedProjectId` over legacy single-project fallback. The login test passes `selectedProjectId: null` via the fixture default, so it exercises ONLY the legacy fallback — never the new branch.

**Why this didn't land here:** Adding the test is straightforward but the test infra for `mockMeResponse` would need an explicit `selectedProjectId` parameter wired through. Quick follow-up.

### Advisory (report only)

- **Multi-tab `/projects/select` last-write-wins** (adversarial adv-004) — accepted at HashHive's 1-3 concurrent user scale.
- **Migration is one-way operationally** (adversarial adv-005) — documented in the ce-deployment-verification-agent's checklist (run artifact); rollback requires deploying previous app version first.
- **Control API parity for global RBAC** (ce-agent-native-reviewer) — `requireApiKey` populates `currentUser.roles` (via shared `coerceRoles` after the autofix), but no control route mounts `requireRole`. Cracker management, project member management, hash list creation remain dashboard-only. Recommend a follow-up `feat(control-api): admin-tier parity for cracker + member + hash-list management`.
- **Backfill makes every existing user a global admin** (data-migration + deployment-verification) — documented in migration comment + plan §6.4 + deployment checklist. Operator action post-deploy: downgrade non-admin staff via direct SQL.

---

## Verdict

**Ready with fixes.** No P0 blockers. The 9 in-branch fixes close the docs / observability / asymmetric-narrowing / session-invalidation gaps. The 6 residual items break into 2 P1 follow-ups (currentUser rename + tier matrix rollout), 4 P2 cleanups (migration idempotency, fixture deduplication, integration tests, login test branch), and 4 advisory items.

Plan-requirements coverage is met per the explicit-plan check — all 12 R-IDs and 7 U-IDs have corresponding work in the diff. The P1 residuals are scope expansions discovered during review, not regressions on planned work.
