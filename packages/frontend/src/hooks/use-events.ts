/**
 * WebSocket-event lifecycle hook (CQ-H5 split).
 *
 * Owns: connection + reconnect + auth refresh + polling fallback +
 * frame envelope validation + the cross-project frame drop.
 *
 * Does NOT own: the routing decision (which queries to invalidate per
 * event type / per agentId / per campaignId). That lives in
 * `lib/event-routing.ts` so it can be unit-tested without standing up
 * a fake WebSocket and so the four invalidation-key maps are
 * module-scoped (no allocation per reconnect).
 */
import type { ConnectionStatus } from '@hashhive/shared'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { authClient } from '../lib/auth-client'
import {
  type AppEvent,
  type EventType,
  isKnownEventType,
  routeEvent,
  sanitizeEventType,
  SYSTEM_EVENT_TYPES,
  warnDriftOnce,
} from '../lib/event-routing'

// Re-export the public types so existing callers importing from this
// hook keep compiling without touching their imports.
export type { AppEvent, EventType } from '../lib/event-routing'

/**
 * Retry budget before transitioning to the `fallback` (polling-only)
 * state. With the budget at 3, the close-handler schedules `1s` then
 * `2s` then drops into fallback -- total active retry window ~3s
 * before polling takes over.
 */
const MAX_RECONNECT_ATTEMPTS = 3

/** Cool-down before the hook leaves `fallback` for one exploratory reconnect. */
const FALLBACK_COOLDOWN_MS = 60_000

type EventHandler = (event: AppEvent) => void

interface UseEventsOptions {
  /** Event types to subscribe to. Defaults to all. */
  types?: EventType[]
  /** Called when a matching event is received. */
  onEvent?: EventHandler
}

/**
 * Connects to the backend WebSocket for real-time events.
 *
 * Surfaces a `status` value (`'connecting' | 'open' | 'authenticating'
 * | 'reconnecting' | 'fallback' | 'error'`) consumed by the layout
 * connection indicator. On auth-failure close (4001) the hook refreshes
 * the session once via
 * `authClient.getSession({ query: { disableCookieCache: true } })`
 * and reconnects; further 4001s land in `error`. After
 * `MAX_RECONNECT_ATTEMPTS` consecutive failed reconnects the hook
 * transitions to `fallback`, where polling keeps caches fresh; one
 * exploratory reconnect fires after `FALLBACK_COOLDOWN_MS`.
 *
 * Project context is derived from `session.session.projectId` -- the
 * server-managed BetterAuth additional field. Incoming frames whose
 * `projectId` doesn't match the session value are dropped client-side
 * as defense-in-depth.
 */
export function useEvents(options: UseEventsOptions = {}) {
  const { types, onEvent } = options
  // Stabilize types array to prevent unnecessary WS reconnections
  const stableTypes = useMemo(() => types?.join(','), [types])
  const { data: session } = authClient.useSession()
  const sessionProjectId =
    (session?.session as { projectId?: number | null } | undefined)?.projectId ?? null
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const reconnectAttemptsRef = useRef(0)
  const authRefreshAttemptedRef = useRef(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!session || !sessionProjectId) {
      setStatus(session ? 'error' : 'connecting')
      return
    }

    const typesParam = stableTypes ? `?types=${stableTypes}` : ''
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/api/v1/dashboard/events/stream${typesParam}`

    let cancelled = false

    function connect() {
      if (cancelled) return
      setStatus(reconnectAttemptsRef.current === 0 ? 'connecting' : 'reconnecting')
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('open')
        reconnectAttemptsRef.current = 0
        authRefreshAttemptedRef.current = false
      }

      ws.onmessage = (event) => {
        try {
          const parsed: unknown = JSON.parse(event.data)
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            typeof (parsed as Record<string, unknown>)['type'] !== 'string'
          ) {
            // oxlint-disable-next-line no-console -- client-side observability has no structured logger
            console.warn('[useEvents] dropped malformed WS frame: invalid envelope')
            return
          }
          const data = parsed as Record<string, unknown>
          if (data['type'] === 'connected' || data['type'] === 'pong') return

          if (
            typeof data['projectId'] !== 'number' ||
            typeof data['timestamp'] !== 'string' ||
            typeof data['data'] !== 'object' ||
            data['data'] === null
          ) {
            // oxlint-disable-next-line no-console -- client-side observability has no structured logger
            console.warn('[useEvents] dropped malformed WS frame: invalid event payload')
            return
          }

          const eventType = data['type'] as string
          if (!isKnownEventType(eventType)) {
            if (warnDriftOnce('unknown', eventType)) {
              // oxlint-disable-next-line no-console -- protocol drift signal
              console.warn('[useEvents] dropped WS frame with unknown event type', {
                eventType: sanitizeEventType(eventType),
              })
            }
            return
          }

          // Project-scope filter (defense-in-depth).
          const frameProjectId = data['projectId'] as number
          if (SYSTEM_EVENT_TYPES.has(eventType)) {
            if (frameProjectId !== 0) {
              if (warnDriftOnce('projectId-mismatch', eventType)) {
                // oxlint-disable-next-line no-console -- protocol drift signal
                console.warn('[useEvents] dropped system WS frame with non-sentinel projectId', {
                  eventType: sanitizeEventType(eventType),
                  frameProjectId,
                })
              }
              return
            }
          } else if (frameProjectId !== sessionProjectId) {
            if (warnDriftOnce('projectId-mismatch', eventType)) {
              // oxlint-disable-next-line no-console -- protocol drift signal
              console.warn('[useEvents] dropped WS frame with mismatched projectId', {
                eventType: sanitizeEventType(eventType),
                frameProjectId,
                sessionProjectId,
              })
            }
            return
          }

          const appEvent: AppEvent = {
            type: eventType,
            projectId: frameProjectId,
            data: data['data'] as Record<string, unknown>,
            timestamp: data['timestamp'] as string,
          }
          // sessionProjectId is non-null inside this effect (guarded
          // at the top), but TS can't follow the closure capture --
          // assert non-null at the call site rather than threading a
          // narrowed local through every branch above.
          routeEvent(appEvent, queryClient, sessionProjectId as number)
          onEventRef.current?.(appEvent)
        } catch (err) {
          // oxlint-disable-next-line no-console -- client-side observability has no structured logger
          console.warn('[useEvents] dropped malformed WS frame', err)
        }
      }

      ws.onclose = (closeEvent) => {
        wsRef.current = null

        if (closeEvent.code === 4001) {
          if (!authRefreshAttemptedRef.current) {
            authRefreshAttemptedRef.current = true
            setStatus('authenticating')
            authClient
              .getSession({ query: { disableCookieCache: true } })
              .catch((err: unknown) => {
                // oxlint-disable-next-line no-console -- client-side observability has no structured logger
                console.warn('[useEvents] session refresh after 4001 close failed', err)
                return null
              })
              .finally(() => {
                if (cancelled) return
                reconnectTimeoutRef.current = setTimeout(connect, 0)
              })
            return
          }
          setStatus('error')
          return
        }

        const attempts = reconnectAttemptsRef.current + 1
        reconnectAttemptsRef.current = attempts

        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          setStatus('fallback')
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current = 0
            authRefreshAttemptedRef.current = false
            connect()
          }, FALLBACK_COOLDOWN_MS)
          return
        }

        setStatus('reconnecting')
        const delay = Math.min(1000 * 2 ** (attempts - 1), 8_000)
        reconnectTimeoutRef.current = setTimeout(connect, delay)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimeout(reconnectTimeoutRef.current)
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      reconnectAttemptsRef.current = 0
      authRefreshAttemptedRef.current = false
      setStatus('connecting')
    }
  }, [session, sessionProjectId, stableTypes, queryClient])

  // Polling fallback: invalidate queries every 30s when the WS is in
  // `fallback` (retry budget exhausted).
  useEffect(() => {
    if (status !== 'fallback') return

    const interval = setInterval(() => {
      const settle = (p: Promise<unknown>) => p.catch((err: unknown) => err)
      void Promise.all([
        settle(queryClient.invalidateQueries({ queryKey: ['dashboard-stats', sessionProjectId] })),
        settle(queryClient.invalidateQueries({ queryKey: ['agents', sessionProjectId] })),
        settle(queryClient.invalidateQueries({ queryKey: ['campaigns', sessionProjectId] })),
        settle(queryClient.invalidateQueries({ queryKey: ['agent'] })),
        settle(queryClient.invalidateQueries({ queryKey: ['agent-errors'] })),
        settle(queryClient.invalidateQueries({ queryKey: ['agent-tasks'] })),
        settle(queryClient.invalidateQueries({ queryKey: ['campaign'] })),
      ]).then((results) => {
        const failures = results.filter((r): r is Error => r instanceof Error)
        if (failures.length > 0) {
          // oxlint-disable-next-line no-console -- polling fallback observability
          console.warn('[useEvents] polling-fallback refresh failures', {
            failureCount: failures.length,
            firstMessage: failures[0]?.message,
          })
        }
      })
    }, 30_000)

    return () => clearInterval(interval)
  }, [status, queryClient, sessionProjectId])

  const connected = status === 'open'
  const polling = status === 'fallback'

  return { status, connected, polling }
}
