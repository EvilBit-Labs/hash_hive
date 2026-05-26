import type { createBunWebSocket } from 'hono/bun'

import { Hono } from 'hono'

import type { EventType } from '../../services/events.js'
import type { AppEnv } from '../../types.js'

import { auth } from '../../lib/auth.js'
import { findProjectMembership } from '../../services/auth.js'
import { getClientCount, registerClient, unregisterClient } from '../../services/events.js'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']

/**
 * Runtime allowlist for the `?types=` query parameter. Without this,
 * `typesParam.split(',') as EventType[]` would silently accept any
 * user-supplied string into the in-memory client registry and reflect
 * it back in the `connected` frame. The list is kept inline (rather
 * than imported from `services/events`) so the existing `mock.module`
 * harness in the backend test suite doesn't need to grow a new export
 * surface. MUST stay in sync with the `EventType` union in
 * `services/events.ts`; adding a new event there should also extend
 * this tuple.
 */
const KNOWN_EVENT_TYPES_FOR_QUERY: ReadonlySet<EventType> = new Set<EventType>([
  'agent_status',
  'agent_error',
  'campaign_status',
  'task_update',
  'crack_result',
  'resource_update',
  'system_health',
])

export function createEventRoutes(upgradeWebSocket: UpgradeWebSocket) {
  const eventRoutes = new Hono<AppEnv>()

  // ─── GET /stream -- WebSocket upgrade for real-time events ───────────

  eventRoutes.get(
    '/stream',
    upgradeWebSocket((c) => {
      let clientId: number | null = null

      return {
        async onOpen(_event, ws) {
          // Authenticate via BetterAuth session cookie (sent on WS upgrade
          // by the browser). No bearer token, no token query param; CLI
          // and TUI clients use the Control API (cst_* keys) per
          // AGENTS.md, not this surface.
          const session = await auth.api
            .getSession({ headers: c.req.raw.headers })
            .catch(() => null)

          if (!session) {
            ws.close(4001, 'Missing authentication (valid session cookie required)')
            return
          }

          const userId = Number(session.user.id)
          if (!Number.isInteger(userId) || userId <= 0) {
            ws.close(4001, 'Invalid session user ID')
            return
          }

          // Read project scope from the server-managed session field.
          // Set by the single-project auto-select hook on sign-in or by
          // POST /api/v1/dashboard/projects/select. No client-supplied
          // scoping is trusted; the previous ?projectIds= query param
          // was removed.
          const sessionProjectId = Number(
            (session.session as { projectId?: number | null }).projectId
          )
          if (!Number.isInteger(sessionProjectId) || sessionProjectId <= 0) {
            ws.close(4002, 'No active project on session (call POST /projects/select first)')
            return
          }

          // Defense-in-depth: confirm the user is still a member of the
          // session's project. The membership was validated when the
          // projectId was written to the session, but it may have been
          // revoked since (e.g., admin removed the user from the
          // project). Without this check, a stale session would keep
          // receiving broadcasts for a project the user no longer has
          // access to.
          const membership = await findProjectMembership(userId, sessionProjectId)
          if (!membership) {
            ws.close(4003, 'User is not a member of the session project')
            return
          }

          const typesParam = c.req.query('types')
          // Filter against the runtime allowlist before storing or
          // reflecting in the `connected` frame. Without this, arbitrary
          // user-supplied strings reach the in-memory client registry
          // and get echoed back to the same authenticated user.
          const eventTypes = typesParam
            ? typesParam
                .split(',')
                .filter((t): t is EventType => KNOWN_EVENT_TYPES_FOR_QUERY.has(t as EventType))
            : undefined

          // Register this WebSocket for broadcasts on the session's project.
          const rawWs = ws.raw as { send: (data: string) => void; readyState: number }
          clientId = registerClient(rawWs, [sessionProjectId], eventTypes)

          ws.send(
            JSON.stringify({
              type: 'connected',
              clientId,
              projectId: sessionProjectId,
              eventTypes: eventTypes ?? 'all',
            })
          )
        },

        onMessage(_event, ws) {
          // Clients don't send messages in this protocol; could be used for ping/pong
          ws.send(JSON.stringify({ type: 'pong' }))
        },

        onClose() {
          if (clientId !== null) {
            unregisterClient(clientId)
          }
        },
      }
    })
  )

  // ─── GET /status -- check event system health ────────────────────────

  eventRoutes.get('/status', (c) => {
    return c.json({
      connectedClients: getClientCount(),
      timestamp: new Date().toISOString(),
    })
  })

  return eventRoutes
}
