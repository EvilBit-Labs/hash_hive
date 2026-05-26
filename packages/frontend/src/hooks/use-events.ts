import type { ConnectionStatus } from '@hashhive/shared'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { authClient } from '../lib/auth-client'

/**
 * Single source of truth for both the `EventType` compile-time union
 * and the runtime membership set below. Adding a new event variant is
 * a one-line change here; the two cannot drift.
 */
const EVENT_TYPES = [
  'agent_status',
  'agent_error',
  'campaign_status',
  'task_update',
  'crack_result',
  'resource_update',
  'system_health',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

/**
 * Membership set for runtime validation of WS frame `type` fields.
 * Without this, an arbitrary string from a misbehaving backend would
 * be cast to `EventType` and forwarded to consumers as if it were a
 * recognized event.
 */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES)

function isKnownEventType(value: string): value is EventType {
  return KNOWN_EVENT_TYPES.has(value)
}

/**
 * Throttle the protocol-drift warnings emitted when a WS event arrives
 * without its expected scoping id (`agentId` or `campaignId`). A
 * misbehaving backend that emits a thousand malformed events in a row
 * would otherwise produce a thousand console warnings; the first warn
 * per `(scope, eventType)` key per cooldown is enough signal.
 */
const DRIFT_WARN_COOLDOWN_MS = 60_000
const driftWarnTimestamps = new Map<string, number>()

/**
 * Retry budget before transitioning to the `fallback` (polling-only)
 * state. Three attempts is the existing exponential-backoff ceiling
 * doubled — the runtime backoff caps at 30s, so three attempts under
 * 4-8s backoff land the operator in fallback within roughly 15s on a
 * sustained outage instead of thrashing reconnects forever.
 */
const MAX_RECONNECT_ATTEMPTS = 3

/**
 * Cool-down before the hook leaves `fallback` to attempt one
 * exploratory reconnect. Polling continues during cool-down, so the
 * operator's cache stays fresh; the cool-down just throttles WS
 * attempts.
 */
const FALLBACK_COOLDOWN_MS = 60_000

/**
 * System-wide event types whose `projectId` payload is the sentinel
 * `0` (see `packages/backend/src/services/events.ts`
 * SYSTEM_EVENT_PROJECT_ID). Bypass the project-scope filter for these
 * — they're intentionally fan-out, not scoped to the active project.
 */
const SYSTEM_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(['system_health'])

/**
 * Sanitize an event-type string for safe logging. Strips characters
 * that could be used to inject ANSI escapes or distort log shape, and
 * caps length so a hostile backend cannot blow out console memory with
 * a 1MB type string. Used everywhere we log a raw event-type value.
 */
function sanitizeEventType(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64)
}

function warnDriftOnce(
  scope: 'agent' | 'campaign' | 'unknown' | 'projectId-mismatch',
  eventType: string
): boolean {
  const safeType = sanitizeEventType(eventType)
  const key = `${scope}:${safeType}`
  const last = driftWarnTimestamps.get(key) ?? 0
  const now = Date.now()
  if (now - last < DRIFT_WARN_COOLDOWN_MS) return false
  driftWarnTimestamps.set(key, now)
  return true
}

export interface AppEvent {
  type: EventType
  projectId: number
  data: Record<string, unknown>
  timestamp: string
}

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
 * the session once via `authClient.getSession({ disableCookieCache })`
 * and reconnects; further 4001s land in `error`. After
 * `MAX_RECONNECT_ATTEMPTS` consecutive failed reconnects the hook
 * transitions to `fallback`, where polling keeps caches fresh; one
 * exploratory reconnect fires after `FALLBACK_COOLDOWN_MS`.
 *
 * Project context is derived from `session.session.projectId` — the
 * server-managed BetterAuth additional field. The URL carries no
 * `projectIds=` query parameter; the server's `events/stream` reads
 * the session field. Incoming frames whose `projectId` doesn't match
 * the session value are dropped client-side as defense-in-depth.
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
  // Tracks whether the current lifecycle has already attempted a
  // session refresh in response to a 4001 close. Reset on `open`.
  // Prevents an infinite refresh-and-retry loop when the session is
  // genuinely terminal (revoked, deleted).
  const authRefreshAttemptedRef = useRef(false)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    if (!session || !sessionProjectId) {
      // Without an authenticated session and a server-managed project
      // context, no WS upgrade can succeed. Surface that to the
      // indicator as `error` so the operator can act (sign in, or call
      // /projects/select via the selector UI).
      setStatus(session ? 'error' : 'connecting')
      return
    }

    const typesParam = stableTypes ? `?types=${stableTypes}` : ''
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/api/v1/dashboard/events/stream${typesParam}`

    // Effect-scoped cancel flag. The 4001 auth-refresh path schedules
    // a setTimeout via getSession().finally(); if the effect re-runs
    // before that promise settles (e.g., because the refreshed session
    // changed the session dep), cleanup cancels the timeout handle but
    // the queued `.finally()` may still schedule the next connect()
    // against a stale closure. The flag short-circuits the queued work.
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

      // Project-scoped query keys: invalidated with [key, selectedProjectId].
      const invalidationKeys: Record<string, string[]> = {
        agent_status: ['agents', 'dashboard-stats'],
        campaign_status: ['campaigns', 'dashboard-stats'],
        // task_update refreshes the campaigns list too because each task
        // affects its campaign's progress percentage and task counts —
        // both of which appear in the list table. Without this, the
        // list's progress column would only refresh on campaign
        // lifecycle transitions, missing per-task progress.
        task_update: ['tasks', 'campaigns', 'dashboard-stats'],
        crack_result: [
          'dashboard-stats',
          'results',
          'hash-list-detail',
          'hash-list-items',
          'hash-lists',
        ],
        resource_update: ['hash-lists', 'wordlists', 'rulelists', 'masklists'],
      }

      // Per-agent query key prefixes. We invalidate `[prefix, agentId]`
      // so only the affected agent's caches refresh — a fleet-wide event
      // stream doesn't fan out into every detail tab. The exact cache
      // shape lives in use-dashboard.ts (`useAgent`, `useAgentErrors`,
      // `useAgentTasks`).
      const agentScopedKeysByEvent: Record<string, string[]> = {
        agent_status: ['agent', 'agent-errors', 'agent-tasks'],
        agent_error: ['agent-errors', 'agent'],
        task_update: ['agent-tasks', 'agent'],
      }

      // Per-campaign query key prefixes. Invalidated as `[prefix, campaignId]`
      // so the detail page refreshes only when the event concerns *its*
      // campaign — fleet-wide task churn doesn't fan out into every cached
      // campaign detail. `task_update` carries `campaignId` so the detail
      // page's `useCampaignDetail` cache (key: `['campaign', id]`) refreshes
      // its taskStats / activeAgents block without a manual reload.
      const campaignScopedKeysByEvent: Record<string, string[]> = {
        campaign_status: ['campaign'],
        task_update: ['campaign'],
      }

      // System-scoped query keys: invalidated with just [key], no project.
      // Issue #109: system_health is system-wide; the query key has no
      // projectId component, so the project-scoped invalidation path
      // would never match it.
      const systemInvalidationKeys: Record<string, string[]> = {
        system_health: ['system-health'],
      }

      ws.onmessage = (event) => {
        try {
          // Validate envelope shape before any cast or invalidation.
          // Without this guard, a non-object payload or one missing a
          // string `type` would still flow through the casts below and
          // hit invalidateQueries / onEvent with malformed data.
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

          // Validate the rest of the envelope before invalidation /
          // callback dispatch. The type guard above only pinned `type`;
          // a frame with `type: 'agent_status'` but missing
          // `projectId`/`timestamp`/`data` would still cast through to
          // AppEvent without these checks.
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
            // Drop rather than forward: invalidationKeys lookups would
            // safely return undefined, but `onEventRef` consumers expect
            // an `AppEvent.type` from the EventType union, and forwarding
            // an unrecognized value would re-introduce the unchecked-cast
            // bug this guard exists to prevent. Throttle the warn so a
            // backend regression cannot flood the console.
            if (warnDriftOnce('unknown', eventType)) {
              const safeType = sanitizeEventType(eventType)
              // oxlint-disable-next-line no-console -- protocol drift signal
              console.warn('[useEvents] dropped WS frame with unknown event type', {
                eventType: safeType,
              })
            }
            return
          }

          // Project-scope filter (defense-in-depth). The server scopes
          // its broadcasts via the session's projectId already, but a
          // buffered cross-project frame can arrive during the brief
          // window between project switch and WS reconnect. System
          // events carry the sentinel projectId 0 and are intentionally
          // global — bypass the filter for those.
          const frameProjectId = data['projectId'] as number
          if (!SYSTEM_EVENT_TYPES.has(eventType) && frameProjectId !== sessionProjectId) {
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

          const projectKeys = invalidationKeys[eventType]
          if (projectKeys) {
            for (const key of projectKeys) {
              void queryClient.invalidateQueries({ queryKey: [key, sessionProjectId] })
            }
          }
          const agentScopedKeys = agentScopedKeysByEvent[eventType]
          if (agentScopedKeys) {
            const payload = data['data'] as Record<string, unknown>
            const rawAgentId = payload['agentId']
            const agentId = typeof rawAgentId === 'number' ? rawAgentId : null
            if (agentId !== null) {
              for (const key of agentScopedKeys) {
                void queryClient.invalidateQueries({ queryKey: [key, agentId] })
              }
            } else {
              // No agentId on the payload — fall back to prefix invalidation
              // so we still refresh, but log so we know the producer should
              // be carrying agentId. Throttled to one warn per (scope,
              // event type) per cooldown so a misbehaving backend cannot
              // flood the console.
              if (warnDriftOnce('agent', eventType)) {
                // oxlint-disable-next-line no-console -- protocol drift signal
                console.warn(
                  '[useEvents] event missing agentId; falling back to broad invalidation',
                  { eventType: sanitizeEventType(eventType) }
                )
              }
              for (const key of agentScopedKeys) {
                void queryClient.invalidateQueries({ queryKey: [key] })
              }
            }
          }
          const campaignScopedKeys = campaignScopedKeysByEvent[eventType]
          if (campaignScopedKeys) {
            const payload = data['data'] as Record<string, unknown>
            const rawCampaignId = payload['campaignId']
            const campaignId = typeof rawCampaignId === 'number' ? rawCampaignId : null
            if (campaignId !== null) {
              for (const key of campaignScopedKeys) {
                void queryClient.invalidateQueries({ queryKey: [key, campaignId] })
              }
            } else {
              // No campaignId on the payload — fall back to prefix invalidation
              // so the detail page still refreshes, but record the drift.
              // Throttled to one warn per (scope, event type) per cooldown.
              if (warnDriftOnce('campaign', eventType)) {
                // oxlint-disable-next-line no-console -- protocol drift signal
                console.warn(
                  '[useEvents] event missing campaignId; falling back to broad invalidation',
                  { eventType: sanitizeEventType(eventType) }
                )
              }
              for (const key of campaignScopedKeys) {
                void queryClient.invalidateQueries({ queryKey: [key] })
              }
            }
          }

          const systemKeys = systemInvalidationKeys[eventType]
          if (systemKeys) {
            for (const key of systemKeys) {
              void queryClient.invalidateQueries({ queryKey: [key] })
            }
          }

          onEventRef.current?.({
            type: data['type'] as EventType,
            projectId: data['projectId'] as number,
            data: data['data'] as Record<string, unknown>,
            timestamp: data['timestamp'] as string,
          })
        } catch (err) {
          // Surface schema drift between server and client to console.
          // Silently dropping the frame would mask backend events from
          // the dashboard with no diagnostic signal.
          // oxlint-disable-next-line no-console -- client-side observability has no structured logger
          console.warn('[useEvents] dropped malformed WS frame', err)
        }
      }

      ws.onclose = (closeEvent) => {
        wsRef.current = null

        // 4001 = auth failure. The session cookie was rejected by the
        // BetterAuth handshake. Refresh the session once (cache-busted)
        // and try one reconnect; if that also closes 4001 we're
        // terminally unauthenticated and the indicator should reflect
        // that, not keep cycling.
        if (closeEvent.code === 4001) {
          if (!authRefreshAttemptedRef.current) {
            authRefreshAttemptedRef.current = true
            setStatus('authenticating')
            authClient
              .getSession({ query: { disableCookieCache: true } })
              .catch(() => null)
              .finally(() => {
                if (cancelled) return
                reconnectTimeoutRef.current = setTimeout(connect, 0)
              })
            return
          }
          // Refresh didn't recover. Terminal.
          setStatus('error')
          return
        }

        // Non-auth close. Apply retry budget.
        const attempts = reconnectAttemptsRef.current + 1
        reconnectAttemptsRef.current = attempts

        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          // Exhausted retries — drop into polling-only mode. The
          // fallback effect below keeps caches fresh. One exploratory
          // reconnect fires after the cool-down; if it lands in `open`,
          // status returns to normal. If it fails again, we re-enter
          // the retry budget from zero. Reset the auth-refresh flag so
          // a session that expired during the outage can be refreshed
          // again on the exploratory attempt (prevents RACE-002 dead
          // flag after long network drops).
          setStatus('fallback')
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttemptsRef.current = 0
            authRefreshAttemptedRef.current = false
            connect()
          }, FALLBACK_COOLDOWN_MS)
          return
        }

        setStatus('reconnecting')
        // Exponential backoff. With MAX_RECONNECT_ATTEMPTS = 3 the
        // actual schedule is: attempt 1 -> 1s, attempt 2 -> 2s, attempt
        // 3 -> fallback (no delay, the budget check above wins). The
        // 8s cap is defensive headroom for any future budget bump that
        // would let attempt 4+ fire (would yield 4s, 8s).
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
        wsRef.current.onclose = null // Prevent reconnect on intentional close
        wsRef.current.close()
        wsRef.current = null
      }
      reconnectAttemptsRef.current = 0
      authRefreshAttemptedRef.current = false
      setStatus('connecting')
    }
  }, [session, sessionProjectId, stableTypes, queryClient])

  // Polling fallback: invalidate queries every 30s when the WS is in
  // `fallback` (retry budget exhausted). Includes the agent-detail
  // keys (broadly, since no event payload is available during polling)
  // so a disconnected detail page still refreshes its tasks/errors/
  // agent caches instead of going stale until the WS reconnects.
  useEffect(() => {
    if (status !== 'fallback') return

    const interval = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard-stats', sessionProjectId] })
      void queryClient.invalidateQueries({ queryKey: ['agents', sessionProjectId] })
      void queryClient.invalidateQueries({ queryKey: ['campaigns', sessionProjectId] })
      void queryClient.invalidateQueries({ queryKey: ['agent'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-errors'] })
      void queryClient.invalidateQueries({ queryKey: ['agent-tasks'] })
      // Symmetric to the agent-detail keys above — without this a
      // disconnected user sitting on /campaigns/:id sees frozen
      // taskStats and activeAgents until the WS reconnects.
      void queryClient.invalidateQueries({ queryKey: ['campaign'] })
    }, 30_000)

    return () => clearInterval(interval)
  }, [status, queryClient, sessionProjectId])

  // Derived booleans for back-compat with existing callers that read
  // `connected`/`polling`. New code should prefer `status`.
  const connected = status === 'open'
  const polling = status === 'fallback'

  return { status, connected, polling }
}
