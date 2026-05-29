/**
 * Pure WS-event routing logic, extracted from `hooks/use-events.ts`
 * (CQ-H5).
 *
 * Pre-split, the four invalidation-key maps lived inside the hook's
 * `connect()` closure and were recreated on every reconnect attempt --
 * GC pressure on reconnect storms. They also coupled the cache-routing
 * decisions to the WebSocket lifecycle, making the routing untestable
 * without standing up a fake WebSocket.
 *
 * Now: maps are module-scoped constants; `routeEvent(frame, qc, sessionProjectId)`
 * is a pure function that consumes a validated frame and emits the
 * right `invalidateQueries` calls. The hook owns lifecycle; this file
 * owns routing.
 */
import type { QueryClient } from '@tanstack/react-query'

// ─── Event type registry (re-exported from use-events for the hook
// to use) ────────────────────────────────────────────────────────────

/**
 * Single source of truth for both the `EventType` compile-time union
 * and the runtime membership set below. Adding a new event variant is
 * a one-line change here; the two cannot drift.
 */
export const EVENT_TYPES = [
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

export function isKnownEventType(value: string): value is EventType {
  return KNOWN_EVENT_TYPES.has(value)
}

/**
 * System-wide event types whose `projectId` payload is the sentinel
 * `0` (see `packages/backend/src/services/events.ts`
 * SYSTEM_EVENT_PROJECT_ID). Bypass the project-scope filter for these
 * -- they're intentionally fan-out, not scoped to the active project.
 */
export const SYSTEM_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(['system_health'])

// ─── AppEvent contract (matches the validated WS frame shape) ────────

export interface AppEvent {
  type: EventType
  projectId: number
  data: Record<string, unknown>
  timestamp: string
}

// ─── Invalidation key maps (module-scoped: stable identity per
// process, no per-reconnect allocation) ──────────────────────────────

/**
 * Project-scoped query keys: invalidated with `[key, sessionProjectId]`.
 */
const projectInvalidationKeys: Readonly<Record<string, readonly string[]>> = {
  agent_status: ['agents', 'dashboard-stats'],
  campaign_status: ['campaigns', 'dashboard-stats'],
  // task_update refreshes the campaigns list too because each task
  // affects its campaign's progress percentage and task counts --
  // both of which appear in the list table. Without this, the list's
  // progress column would only refresh on campaign lifecycle
  // transitions, missing per-task progress.
  task_update: ['tasks', 'campaigns', 'dashboard-stats'],
  crack_result: ['dashboard-stats', 'results', 'hash-list-detail', 'hash-list-items', 'hash-lists'],
  resource_update: ['hash-lists', 'wordlists', 'rulelists', 'masklists'],
}

/**
 * Per-agent query key prefixes. Invalidated as `[prefix, agentId]` so
 * only the affected agent's caches refresh -- a fleet-wide event
 * stream doesn't fan out into every detail tab.
 */
const agentScopedKeysByEvent: Readonly<Record<string, readonly string[]>> = {
  agent_status: ['agent', 'agent-errors', 'agent-tasks'],
  agent_error: ['agent-errors', 'agent'],
  task_update: ['agent-tasks', 'agent'],
}

/**
 * Per-campaign query key prefixes. Invalidated as `[prefix, campaignId]`
 * so the detail page refreshes only when the event concerns *its*
 * campaign.
 */
const campaignScopedKeysByEvent: Readonly<Record<string, readonly string[]>> = {
  campaign_status: ['campaign'],
  task_update: ['campaign'],
}

/**
 * System-scoped query keys: invalidated with just `[key]`, no project.
 */
const systemInvalidationKeys: Readonly<Record<string, readonly string[]>> = {
  system_health: ['system-health'],
}

// ─── Drift-warn throttling (module-scoped state) ─────────────────────

const DRIFT_WARN_COOLDOWN_MS = 60_000
const driftWarnTimestamps = new Map<string, number>()

export function sanitizeEventType(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '?').slice(0, 64)
}

export function warnDriftOnce(
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

// ─── Pure routing function ───────────────────────────────────────────

/**
 * Route a validated AppEvent to the right set of `invalidateQueries`
 * calls. Pure -- no React, no WebSocket, no setState. Callers (the
 * hook's onmessage handler) own envelope parsing + validation + the
 * project-scope filter; this function trusts what it gets.
 *
 * Returns nothing. Side effects are limited to `qc.invalidateQueries`
 * and (in fallback drift cases) `console.warn`.
 */
export function routeEvent(frame: AppEvent, qc: QueryClient, sessionProjectId: number): void {
  const { type: eventType, data } = frame

  // Project-scoped fan-out.
  const projectKeys = projectInvalidationKeys[eventType]
  if (projectKeys) {
    for (const key of projectKeys) {
      void qc.invalidateQueries({ queryKey: [key, sessionProjectId] })
    }
  }

  // Per-agent fan-out.
  const agentScopedKeys = agentScopedKeysByEvent[eventType]
  if (agentScopedKeys) {
    const rawAgentId = data['agentId']
    const agentId = typeof rawAgentId === 'number' ? rawAgentId : null
    if (agentId !== null) {
      for (const key of agentScopedKeys) {
        void qc.invalidateQueries({ queryKey: [key, agentId] })
      }
    } else {
      if (warnDriftOnce('agent', eventType)) {
        // oxlint-disable-next-line no-console -- protocol drift signal
        console.warn('[event-routing] event missing agentId; falling back to broad invalidation', {
          eventType: sanitizeEventType(eventType),
        })
      }
      for (const key of agentScopedKeys) {
        void qc.invalidateQueries({ queryKey: [key] })
      }
    }
  }

  // Per-campaign fan-out.
  const campaignScopedKeys = campaignScopedKeysByEvent[eventType]
  if (campaignScopedKeys) {
    const rawCampaignId = data['campaignId']
    const campaignId = typeof rawCampaignId === 'number' ? rawCampaignId : null
    if (campaignId !== null) {
      for (const key of campaignScopedKeys) {
        void qc.invalidateQueries({ queryKey: [key, campaignId] })
      }
    } else {
      if (warnDriftOnce('campaign', eventType)) {
        // oxlint-disable-next-line no-console -- protocol drift signal
        console.warn(
          '[event-routing] event missing campaignId; falling back to broad invalidation',
          { eventType: sanitizeEventType(eventType) }
        )
      }
      for (const key of campaignScopedKeys) {
        void qc.invalidateQueries({ queryKey: [key] })
      }
    }
  }

  // System fan-out (no projectId scoping).
  const systemKeys = systemInvalidationKeys[eventType]
  if (systemKeys) {
    for (const key of systemKeys) {
      void qc.invalidateQueries({ queryKey: [key] })
    }
  }
}
