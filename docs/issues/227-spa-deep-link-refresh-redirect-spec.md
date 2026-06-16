# Issue #227 — SPA deep-link / page-refresh on sub-routes redirects to the Dashboard

> **Status:** Spec — ready for implementation
> **Priority:** P1 (high — degrades the documented primary use: long monitoring sessions on a wall display) · **Labels:** bug, frontend
> **Blocked by:** None · **Blocks:** None
> **Related:** #178 (login & project selection wired to server-managed scope, merged), #160 (server-managed scope), #226/#99 (the PR/branch the bug was found alongside — unrelated to its feature work)
> **Source:** Found during a live `/critique` of PR #226; reproduced by the project owner and by Playwright `page.goto`.

## Issue Summary

Direct navigation to any dashboard sub-route — typing the URL in the address bar **or refreshing the page** — lands the operator on the Dashboard (`/`) instead of the requested route. Only in-app client-side navigation (clicking sidebar links) reaches sub-routes. The cause is a route guard that decides "no project → redirect" before the project membership fetch has resolved on a cold load, so the original destination is discarded through two `replace` navigations.

## Problem Statement

`selectedProjectId` is deliberately **not** persisted to local storage — it mirrors the server-managed `session.projectId` (post-#159) and is rehydrated by an async `fetchProjects()` call on boot (`stores/ui.ts:38-45` `partialize` excludes it; `stores/auth.ts:60` `fetchProjects`). On a hard load the value is `null` until that fetch resolves.

`ProtectedRoute` makes its redirect decision the moment the session resolves, without waiting for the project fetch:

```tsx
// packages/frontend/src/components/features/protected-route.tsx
if (isPending) return <Loading />
if (!session) return <Navigate to="/login" replace />
if (!selectedProjectId) return <Navigate to="/select-project" replace />   // fires too early on cold load
return <Outlet />
```

Cold-load trace for `/campaigns`:

1. `isPending` true → Loading. (URL still `/campaigns`.)
2. Session resolves; `selectedProjectId` is still `null` because `fetchProjects()` (kicked off by the effect in `main.tsx:69`) has not resolved yet → `<Navigate to="/select-project" replace />`. **The `/campaigns` destination is discarded.**
3. `fetchProjects()` resolves, sets `selectedProjectId` to the server's value.
4. `SelectProjectPage` sees a truthy `selectedProjectId` → `<Navigate to="/" replace />` (`pages/select-project.tsx:44`). **Operator lands on the Dashboard.**

Client-side navigation works because by then `selectedProjectId` is already hydrated, so step 2 never redirects.

The fix already exists one component over: `LoginPage` gates the identical decision behind the fetch-complete flag — `if (session && hasFetchedProjects && !selectedProjectId)` (`pages/login.tsx:40`). `ProtectedRoute` simply omits the `hasFetchedProjects` guard. This is a one-condition divergence, not a deep architectural problem.

## Technical Approach

Mirror the `LoginPage` gating in `ProtectedRoute`: treat "session present but project membership not yet fetched" as a loading state, so the guard waits for `fetchProjects()` to resolve before deciding whether a project is genuinely missing. While loading, render nothing that navigates — the URL stays on the requested route, and once `selectedProjectId` hydrates the `Outlet` renders and React Router matches the original path (`/campaigns`) with no navigation having occurred.

The `hasFetchedProjects` flag in the auth store is the correct signal: it flips to `true` in **both** the success and failure branches of `fetchProjects` (`stores/auth.ts:69,82`), so the guard can never hang — a `/me` failure (e.g. expired session) sets `projects: []` and clears the selection, falling through to the genuine `/select-project` (or, via `lib/api.ts`'s 401 handler, `/login`) redirect.

### Key design decisions

- **Gate on `hasFetchedProjects`, not on a new state.** The flag already exists, is already consumed by `LoginPage` for the same decision, and is set in every terminal branch of the fetch. Reusing it keeps the two guards consistent (DRY) and avoids inventing a parallel hydration signal.
- **Loading condition:** show the loading state when `isPending` **or** (`session` present **and** `!hasFetchedProjects`). Only after the fetch resolves does `!selectedProjectId` mean "genuinely no project → `/select-project`".
- **No change to `selectedProjectId` persistence.** Persisting it would reintroduce the race the `partialize` comment warns against (a cached id could disagree with the server's truth on every load). The fix is to *wait* for the server truth, not to cache a guess.
- **Deep-link preservation through `/select-project` is out of scope.** This fix preserves the destination for the common case (a project is selected server-side — single-project users and any user whose session carries `projectId`). A genuine multi-project user with no server-side selection still goes through `/select-project`, which redirects to `/` after picking. Capturing and restoring the intended destination across the selector is a separate enhancement (see Out of Scope).

## Implementation Plan

1. **`ProtectedRoute` guard** (`packages/frontend/src/components/features/protected-route.tsx`): read `hasFetchedProjects` from the auth store (`useAuthStore`); extend the loading condition to `isPending || (session && !hasFetchedProjects)`; keep the `!session → /login` and post-fetch `!selectedProjectId → /select-project` redirects unchanged.
2. **Update the existing test harness** (`packages/frontend/tests/components/protected-route.test.tsx`). The current harness mounts only `<Route index>` under `ProtectedRoute` and drives only `useUiStore` + the mocked session — it cannot express the new cases as-is. The implementer must:
   - Add a real `/campaigns` route inside the `MemoryRouter` tree so the deep-link-preservation assertion has something to render and the URL can be checked.
   - Drive the **auth** store, not just the UI store: `useAuthStore.setState({ hasFetchedProjects: ... })` in each case, and reset it in `afterEach` alongside the existing cleanup.
   - Update the existing "redirects to /select-project when authenticated but no project selected" case to set `hasFetchedProjects: true` — without it that test will start asserting the loading state after the fix.

## Test Plan

Unit (bun:test + Testing Library, mirroring the existing `protected-route.test.tsx` harness):

- **Cold load, fetch in flight:** `session` present, `hasFetchedProjects: false`, `selectedProjectId: null` → renders the loading state, **does not** navigate to `/select-project` or `/`. (RED against current code.)
- **Deep-link preserved:** with a `/campaigns` route added to the harness tree, render at `/campaigns` in the cold-load state above, then flip `hasFetchedProjects: true` + `selectedProjectId: 1` → the `/campaigns` content renders and the URL is still `/campaigns` (no redirect to `/`).
- **Genuine no-project (fetch complete):** `session` present, `hasFetchedProjects: true`, `selectedProjectId: null` → redirects to `/select-project`. (Updated existing test.)
- **Fetch failed → falls through:** `hasFetchedProjects: true`, `projects: []`, `selectedProjectId: null` → redirects to `/select-project` (does not hang on loading).
- **Unchanged regressions:** not authenticated → `/login`; authenticated + project selected → outlet; session pending → loading.

E2E (Playwright, the reproduction path from the issue):

- `page.goto('/campaigns')` after sign-in resolves on `/campaigns` with the Campaigns view rendered (not `/`).
- Reload while on `/agents` (or `/resources`, `/results`) stays on that route.

## Files to Modify

- `packages/frontend/src/components/features/protected-route.tsx` — add the `hasFetchedProjects` loading gate.
- `packages/frontend/tests/components/protected-route.test.tsx` — update the no-project case, add cold-load + deep-link cases.
- (If an e2e lane covers routing) add/extend a Playwright spec asserting deep-link + refresh on sub-routes; otherwise note the manual repro is covered by the unit deep-link test.

## Success Criteria

- [ ] Typing `/campaigns` (or any sub-route) in the address bar after sign-in loads that route, not the Dashboard.
- [ ] Refreshing the browser on any sub-route stays on that route.
- [ ] Shared deep links to sub-routes resolve correctly for a signed-in operator with a server-selected project.
- [ ] A genuine no-project user still reaches `/select-project`; an expired session still reaches `/login` — neither hangs on the loading state.
- [ ] `ProtectedRoute` and `LoginPage` gate the no-project decision identically (both behind `hasFetchedProjects`).
- [ ] `just ci-check` green.

## Out of Scope / Known Limitations

- **Destination preservation across `/select-project`.** A multi-project user with no server-side selection is still sent to the selector, which redirects to `/` after a pick. Carrying the originally requested path through the selector (e.g. via router `location.state` or a `?next=` param) is a follow-up enhancement, not part of this bug fix.
- **Persisting `selectedProjectId` locally.** Intentionally avoided — it would race the server's session truth (see the `partialize` comment in `stores/ui.ts`). The fix waits for the server value instead of caching it.
- **Server-side rendering / static prerender of sub-routes.** Not applicable; this is a client-rendered SPA and the dev/prod server already serves `index.html` for unknown paths (the SPA fallback is what lets a hard load reach the router at all).
