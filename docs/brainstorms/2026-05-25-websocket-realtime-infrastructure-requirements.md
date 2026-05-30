---
date: 2026-05-25
topic: websocket-realtime-infrastructure
---

# WebSocket Realtime Infrastructure (Issue #158)

## Summary

Harden the dashboard WebSocket event channel with four operator-facing capabilities — authenticated handshake with reconnect-on-expiry, polling fallback when the WS is unavailable, project-scoped client-side filtering, and a connection status indicator in the layout shell. Borrows the BetterAuth session-projectId extension from issue #159 so the WebSocket can read project context from the session rather than a client-supplied query parameter.

---

## Problem Frame

The dashboard frontend opens a single WebSocket connection at the layout level (`packages/frontend/src/components/features/events-provider.tsx`) to receive real-time updates for campaigns, agents, tasks, and results. Issue #150 shipped the first slice — `useEvents` invalidates the right query keys on `task_update` and the `isKnownEventType` guard drops unrecognized frames.

Four gaps remain from the original spec ticket (`spec/tickets/Real-Time_Events_&_WebSocket_Infrastructure.md`):

1. The handshake authenticates via BetterAuth cookie, but there is no client-side recovery when the session expires mid-session — the connection drops and reconnects forever without refreshing the session.
2. There is a polling effect, but it activates on every close rather than after a real retry budget is exhausted. Operators on flaky networks see thrashing.
3. Project scoping is enforced on the server, but the client trusts whatever `projectId` the frame carries. During a fast project switch, a buffered cross-project frame can invalidate the wrong cache.
4. No UI surface tells the operator whether they're receiving live updates or watching stale data.

A separate issue (#159) is queued next to add server-managed `projectId` on the BetterAuth session plus RBAC. The WS endpoint today reads `?projectIds=` from the query — a client-supplied scoping vector that #159 will replace. Shipping #158 without touching that path entrenches the query-param model and forces #159 to undo it.

---

## Requirements

**Connection authentication and recovery**

- R1. The WebSocket handshake authenticates the operator via BetterAuth session cookie. No new auth transport is added (no JWT, no token query param) — the cookie is sent automatically by the browser on upgrade.
- R2. When the WebSocket closes with an authentication-failure code (`4001`), the client refreshes the BetterAuth session once via the client SDK (`disableCookieCache: true`) and attempts one reconnect. If the reconnect also fails with `4001`, the connection enters a terminal error state and stops retrying until the next session change.
- R3. The hook exposes a single `status` value drawn from a fixed set: `connecting`, `open`, `authenticating`, `reconnecting`, `fallback`, `error`. Existing `connected` and `polling` booleans are derived from `status` so existing call sites continue to work.

**Polling fallback**

- R4. After a configurable number of consecutive failed WebSocket reconnects (default 3), the hook transitions to `fallback` and stops attempting WebSocket reconnects until a cool-down period elapses (default 60 seconds), then retries once.
- R5. While in `fallback`, the polling effect invalidates the same TanStack Query keys that real-time events would have invalidated, at a fixed interval (30 seconds, unchanged from current behavior). Consumers see no functional difference beyond increased latency.
- R6. The retry budget and cool-down are constants in the hook module, not props — operators do not configure them at runtime.

**Project-scoped filtering**

- R7. The WebSocket endpoint reads the active `projectId` from the BetterAuth session (`session.session.projectId`), not from a client-supplied query parameter. The `?projectIds=` query parameter on `/api/v1/dashboard/events/stream` is removed.
- R8. The frontend hook compares each incoming event's `projectId` against the project derived from `authClient.useSession()`. Events whose `projectId` does not match are silently dropped with a throttled diagnostic warning (same throttle pattern as the existing `warnDriftOnce` helper).
- R9. The UI store's `selectedProjectId` is updated to reflect session state on each session change rather than acting as the source of truth. Other hooks that read project context (campaign list, dashboard stats, etc.) continue to work because the UI store value is now derived from the session.

**Connection status indicator**

- R10. A small visual indicator is rendered in the layout shell (`packages/frontend/src/components/features/layout.tsx`) at all times the operator is authenticated. The indicator reflects the `status` value from R3.
- R11. The indicator has three visual states: live (`status === 'open'`), transitional (`status` in `connecting | reconnecting | authenticating`), and offline (`status` in `fallback | error`). Each state has a distinct color and accessible label.
- R12. The indicator uses Tailwind utility classes only — no new dependencies, no new design tokens.

**Auth plumbing borrowed from #159 (means to an end for R7)**

- R13. The BetterAuth session is extended with `additionalFields.projectId` of type `number`, not required. This is the same field #159 specifies in its step 1.
- R14. A `POST /api/v1/dashboard/projects/select` endpoint validates project membership for the authenticated user and updates the session's `projectId` via `auth.api.updateSession`. The endpoint returns the selected project.
- R15. On login, if the authenticated user has exactly one accessible project, the backend automatically calls the same membership-validate-and-update path so `session.projectId` is set without requiring frontend action. Multi-project users land with no `projectId` and the indicator shows offline until #160 ships the selector UI.

**Shared types**

- R16. `ConnectionStatus` (the R3 union) is defined as a Zod schema in `@hashhive/shared` and exported as a `z.infer` type. The hook and the indicator both consume it from the shared package.
- R17. The OpenAPI spec (`packages/openapi/dashboard-api.yaml`) is updated in the same changeset to (a) remove the `projectIds` query parameter from `/events/stream`, (b) document the close codes (`4001` auth, `4002` no project context, `4003` not a member), (c) add the new `POST /projects/select` endpoint.

---

## Acceptance Examples

- AE1. **Covers R2, R3.** Given an operator with an expired BetterAuth session, when the WebSocket closes with code `4001`, the hook transitions `open → authenticating`, calls `authClient.getSession({ disableCookieCache: true })`, then reconnects once. If the reconnect succeeds, status returns to `open`. If it also closes with `4001`, status becomes `error` and no further reconnects occur.

- AE2. **Covers R4, R5.** Given an operator whose WebSocket has closed three consecutive times without a successful `open` event, when the third reconnect fails, the hook transitions to `fallback`. The polling effect fires at 30-second intervals, invalidating dashboard-stats, campaigns, agents, and campaign-detail query keys. After 60 seconds, the hook attempts one WebSocket reconnect. If it succeeds, polling stops.

- AE3. **Covers R7, R8.** Given an operator viewing project A, when they navigate to project B and a buffered `task_update` event for project A arrives before the WebSocket reconnects with the new session-scoped project, the client drops the event silently and logs a throttled warning. No query invalidation fires for project A's cache.

- AE4. **Covers R10, R11.** Given an operator on the dashboard with an open WebSocket, when the indicator is rendered, it shows a green dot with `aria-label="Live"`. When the WS closes and reconnects are in progress, it shows an amber dot with a pulse animation. When the hook transitions to `fallback`, it shows a red dot with `aria-label="Offline — polling"`.

- AE5. **Covers R15.** Given an operator with membership in exactly one project, when they complete BetterAuth sign-in, the backend automatically updates the session with that project's id. The first WebSocket upgrade after sign-in reads `projectId` from the session and registers the client for that project's broadcasts. No frontend action is required.

---

## Success Criteria

- An operator on the dashboard knows at all times whether they're receiving live updates, transitioning, or offline — without opening DevTools.
- An operator whose session expires mid-session has their session refreshed and connection restored without a page reload.
- An operator on a flaky network sees a stable fallback state with continued data updates, not a thrashing reconnect loop.
- An operator who navigates between projects never sees stale data from the previous project bleed into the current project's cache.
- Issue #159 inherits a working BetterAuth session-projectId pattern and can focus on the listing endpoint, multi-project selector logic, "remember last project", and RBAC — without touching the WebSocket endpoint or undoing #158's work.
- `just check` and `just ci-check` pass before opening the PR.

---

## Scope Boundaries

- `GET /api/v1/dashboard/projects` (project listing endpoint) — owned by #159
- Multi-project switcher logic and selector UI — owned by #159 (backend) and #160 (frontend UI)
- "Remember last project" persisted in user preferences — owned by #159
- RBAC middleware, `requireRole` guard, and the Admin/Operator/Analyst role enforcement — owned by #159
- `SessionUser.roles` in `@hashhive/shared` — owned by #159 (this issue scaffolds `SessionUser` with the `projectId` field only)
- Redis pub/sub multi-instance support — deferred per spec ticket
- Event replay, event history, event persistence — deferred per spec ticket
- Server-side rate limiting on `/events/stream` — separate concern, not in this scope
- New auth transport (JWT, token query param, etc.) — explicitly not added; the stale spec mention of `?token=<session-jwt>` is dropped because CLI/TUI clients use the Control API, not the dashboard WebSocket

---

## Key Decisions

- **Session as the source of truth for projectId, not the UI store.** The BetterAuth session field is server-managed and untrustable from the client; the UI store becomes a reflection of it. This removes the client-supplied scoping vector on `/events/stream` and gives #159 a clean inheritance point. The trade-off is that #158 absorbs a piece of #159's backend work (~50 LOC for the session field, select endpoint, and auto-select).
- **Single-project auto-select pulled forward from #159.** Without it, the connection indicator shows `error` for every operator until #160 ships the selector UI. Pulling forward the ~10 LOC of auto-select logic lets #158 ship a working operator experience for the single-project case (most early users).
- **No new auth transport.** BetterAuth cookies are sent automatically on WebSocket upgrade; no JWT, no `?token=` query param, no `Authorization` header. The stale `?token=` mention in the spec ticket is dropped — CLI/TUI clients use the Control API per AGENTS.md.
- **Status machine over multiple booleans.** A single `ConnectionStatus` discriminated union replaces the `connected`/`polling` booleans as the primary state. Booleans remain as derived values for backwards compatibility with current consumers but new code reads `status`.
- **Retry budget and cool-down as module constants, not props.** Operators do not tune networking parameters at runtime. Defaults (3 retries, 60s cool-down) are based on the existing exponential backoff ceiling and can be revised if telemetry shows they're wrong.

---

## Dependencies / Assumptions

- BetterAuth's `additionalFields` on the session supports `number` type and round-trips through `auth.api.updateSession`. This is documented behavior but not currently exercised in this codebase — assumption is checked during planning by reading the BetterAuth integration in `packages/backend/src/lib/auth.ts`.
- The frontend's `authClient.useSession()` re-fetches when `disableCookieCache: true` is passed. Assumption based on BetterAuth client docs; verified during planning.
- `selectedProjectId` in the UI store is currently the source of truth for project context across hooks beyond `useEvents`. Migrating to session-derived project context may ripple to other hooks (campaign list, dashboard stats, etc.) — the ripple's surface area is unknown until planning surveys the consumers.
- Issue #159 will land within the next iteration; no architectural concessions are made to support indefinite single-project-only operation. The connection indicator showing `error` for multi-project users in the gap between #158 and #160 is acceptable.

---

## Outstanding Questions

### Deferred to Planning

- **[Affects R9][Technical]** How many frontend hooks currently read `selectedProjectId` from the UI store directly, and does converting it to a session-derived reflection require changes to those consumers or only to the UI store's update path?
- **[Affects R15][Technical]** When BetterAuth fires a sign-in event, what's the right hook to perform the single-project auto-select — a BetterAuth lifecycle hook, a `POST /sign-in/email` middleware, or first-request lazy initialization on any dashboard endpoint?
- **[Affects R17][Needs research]** Does the existing OpenAPI contract test (`tests/contract/`) verify the absence of removed parameters, or only the presence of declared ones? If only presence, the `?projectIds=` removal needs a test addition.
- **[Affects R8][Technical]** Does the current `events.ts` backend actually attach `projectId` to outgoing frames in every code path that emits events? If any code path emits events without `projectId`, the client filter's drop-on-mismatch would silently swallow valid frames.
