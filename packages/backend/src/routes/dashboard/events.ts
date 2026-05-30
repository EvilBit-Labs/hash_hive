import type { createBunWebSocket } from 'hono/bun'

import { Hono } from 'hono'

import type { EventType } from '../../services/events.js'
import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'
import { auth } from '../../lib/auth.js'
import { findProjectMembership } from '../../services/auth.js'
import { getClientCount, registerClient, unregisterClient } from '../../services/events.js'

type UpgradeWebSocket = ReturnType<typeof createBunWebSocket>['upgradeWebSocket']

const WS_AUTH_TIMEOUT_DEFAULT_MS = 10_000

/**
 * Upper bound on how long the WS upgrade handler will wait on any
 * single upstream call (BetterAuth session lookup, membership lookup).
 * Without this, a hung upstream (degraded Postgres, hung BetterAuth
 * request) leaves the WebSocket in a non-terminal state: the client
 * sees no `connected` frame and no close code, and the in-flight
 * promise pins the handler forever. 10s is well above p99 latency for
 * a session+membership lookup on a healthy stack and short enough that
 * the client's retry-budget kicks in before the user notices a hang.
 *
 * Read at call time (not module load) so tests can override via
 * `HH_WS_AUTH_TIMEOUT_MS` without fighting ESM import hoisting, and so
 * operators can adjust the ceiling without redeploying.
 */
function getWsAuthTimeoutMs(): number {
  const raw = process.env['HH_WS_AUTH_TIMEOUT_MS']
  if (!raw) return WS_AUTH_TIMEOUT_DEFAULT_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : WS_AUTH_TIMEOUT_DEFAULT_MS
}

/**
 * Marker error thrown by `withTimeout` when the timeout wins. Distinct
 * class so callers can distinguish "the upstream call took too long"
 * from "the upstream call threw" — the two require different close
 * codes and different log levels. Without this distinction, a
 * `.catch(() => null)` would collapse BetterAuth/DB faults into the
 * missing-auth (4001) path, hiding the real failure and routing the
 * client through an inappropriate recovery flow (session refresh
 * instead of retry-budget).
 */
class WsTimeoutError extends Error {
  constructor() {
    super('timeout')
    this.name = 'WsTimeoutError'
  }
}

/**
 * Race a promise against a timeout. Throws `WsTimeoutError` if the
 * timer wins; otherwise the inner promise's resolution/rejection
 * passes through unchanged. Callers are expected to branch on the
 * error class so true timeouts map to the timeout-specific close
 * codes (4001 / 4500) and unexpected upstream errors are logged and
 * mapped to a generic internal-error close code.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new WsTimeoutError()), ms)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

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
          //
          // Three outcomes:
          //   - session resolves with a value -> proceed
          //   - session resolves null OR getSession throws WsTimeoutError -> 4001
          //     (frontend will refresh + retry once; a persistent outage
          //     lands in terminal `error` instead of an indefinite hang)
          //   - getSession throws any other error -> log + close 1011 internal
          //     (do NOT collapse to 4001 -- a DB fault is not a missing
          //     session and shouldn't trigger an auth-refresh recovery)
          let session: Awaited<ReturnType<typeof auth.api.getSession>>
          try {
            session = await withTimeout(
              auth.api.getSession({ headers: c.req.raw.headers }),
              getWsAuthTimeoutMs()
            )
          } catch (err) {
            if (err instanceof WsTimeoutError) {
              ws.close(4001, 'Auth lookup timed out')
              return
            }
            logger.error({ err }, 'WS upgrade: auth.api.getSession threw unexpectedly')
            ws.close(1011, 'Internal server error during auth lookup')
            return
          }

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
          // session's project. Three outcomes mirror the session lookup
          // above:
          //   - resolves with a row -> proceed
          //   - resolves null -> 4003 (revoked membership)
          //   - throws WsTimeoutError -> 4500 (backend degraded; the
          //     frontend's retry-budget path handles transient outages
          //     without mistaking them for a permission decision)
          //   - throws any other error -> log + 1011 (DB faults are
          //     server-side problems, not authorization signals)
          let membership: Awaited<ReturnType<typeof findProjectMembership>>
          try {
            membership = await withTimeout(
              findProjectMembership(userId, sessionProjectId),
              getWsAuthTimeoutMs()
            )
          } catch (err) {
            if (err instanceof WsTimeoutError) {
              ws.close(4500, 'Backend degraded (membership lookup timeout)')
              return
            }
            logger.error(
              { err, userId, projectId: sessionProjectId },
              'WS upgrade: findProjectMembership threw unexpectedly'
            )
            ws.close(1011, 'Internal server error during membership lookup')
            return
          }

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
