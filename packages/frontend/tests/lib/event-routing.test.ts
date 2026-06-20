import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, mock } from 'bun:test'

import {
  type AppEvent,
  EVENT_TYPES,
  isKnownEventType,
  routeEvent,
  sanitizeEventType,
  SYSTEM_EVENT_TYPES,
} from '../../src/lib/event-routing'

const SESSION_PROJECT_ID = 7

function frame(
  type: AppEvent['type'],
  data: Record<string, unknown> = {},
  projectId = SESSION_PROJECT_ID
): AppEvent {
  return {
    type,
    projectId,
    data,
    timestamp: '2026-05-28T00:00:00Z',
  }
}

type InvalidateMock = ReturnType<typeof mock<(arg: { queryKey: unknown[] }) => Promise<void>>>

function makeClient(): { qc: QueryClient; invalidate: InvalidateMock } {
  const invalidate: InvalidateMock = mock(() => Promise.resolve())
  const qc = new QueryClient()
  Object.defineProperty(qc, 'invalidateQueries', { value: invalidate, writable: true })
  return { qc, invalidate }
}

function keys(invalidate: InvalidateMock): unknown[][] {
  return invalidate.mock.calls.map(([arg]) => arg.queryKey)
}

describe('isKnownEventType', () => {
  it('accepts the documented event-type vocabulary', () => {
    expect(isKnownEventType('agent_status')).toBe(true)
    expect(isKnownEventType('crack_result')).toBe(true)
    expect(isKnownEventType('system_health')).toBe(true)
  })

  it('rejects strings outside the vocabulary', () => {
    expect(isKnownEventType('unknown_type')).toBe(false)
    expect(isKnownEventType('')).toBe(false)
  })
})

describe('SYSTEM_EVENT_TYPES', () => {
  it('contains only system_health (bypasses project filter)', () => {
    expect(SYSTEM_EVENT_TYPES.has('system_health')).toBe(true)
    expect(SYSTEM_EVENT_TYPES.has('agent_status')).toBe(false)
  })
})

describe('sanitizeEventType', () => {
  it('strips control characters and caps length', () => {
    expect(sanitizeEventType('agent_status')).toBe('agent_status')
    expect(sanitizeEventType('bad type<script>')).toBe('bad?type?script?')
    expect(sanitizeEventType('a'.repeat(100))).toHaveLength(64)
  })
})

describe('routeEvent: project-scoped fan-out', () => {
  let qc: QueryClient
  let invalidate: InvalidateMock
  beforeEach(() => {
    ;({ qc, invalidate } = makeClient())
  })

  it('agent_status invalidates agents + dashboard-stats (project-scoped)', () => {
    routeEvent(frame('agent_status', { agentId: 1 }), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['agents', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['dashboard-stats', SESSION_PROJECT_ID])
  })

  it('campaign_status invalidates campaigns + dashboard-stats', () => {
    routeEvent(frame('campaign_status', { campaignId: 42 }), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['campaigns', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['dashboard-stats', SESSION_PROJECT_ID])
  })

  it('task_update refreshes tasks + campaigns + dashboard-stats (campaigns list shows per-task progress)', () => {
    routeEvent(frame('task_update', { agentId: 1, campaignId: 42 }), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['tasks', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['campaigns', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['dashboard-stats', SESSION_PROJECT_ID])
  })

  it('crack_result invalidates the full result + hash-list cluster', () => {
    routeEvent(frame('crack_result'), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['results', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['hash-list-detail', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['hash-list-items', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['hash-lists', SESSION_PROJECT_ID])
  })

  it('resource_update fans out across resource list types', () => {
    routeEvent(frame('resource_update'), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['hash-lists', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['wordlists', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['rulelists', SESSION_PROJECT_ID])
    expect(k).toContainEqual(['masklists', SESSION_PROJECT_ID])
  })
})

describe('routeEvent: per-agent fan-out', () => {
  let qc: QueryClient
  let invalidate: InvalidateMock
  beforeEach(() => {
    ;({ qc, invalidate } = makeClient())
  })

  it('scopes agent_status to the affected agentId', () => {
    routeEvent(frame('agent_status', { agentId: 99 }), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['agent', 99])
    expect(k).toContainEqual(['agent-errors', 99])
    expect(k).toContainEqual(['agent-tasks', 99])
  })

  it('agent_error invalidates errors + agent for the specific agent', () => {
    routeEvent(frame('agent_error', { agentId: 5 }), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['agent-errors', 5])
    expect(k).toContainEqual(['agent', 5])
  })

  it('falls back to broad invalidation when agentId is missing', () => {
    routeEvent(frame('agent_status'), qc, SESSION_PROJECT_ID)
    const k = keys(invalidate)
    expect(k).toContainEqual(['agent'])
    expect(k).toContainEqual(['agent-errors'])
    expect(k).toContainEqual(['agent-tasks'])
    expect(k).not.toContainEqual(['agent', SESSION_PROJECT_ID])
  })
})

describe('routeEvent: per-campaign fan-out', () => {
  let qc: QueryClient
  let invalidate: InvalidateMock
  beforeEach(() => {
    ;({ qc, invalidate } = makeClient())
  })

  it('scopes campaign_status to the affected campaignId', () => {
    routeEvent(frame('campaign_status', { campaignId: 17 }), qc, SESSION_PROJECT_ID)
    expect(keys(invalidate)).toContainEqual(['campaign', 17])
  })

  it('task_update touches the campaign detail when campaignId is present', () => {
    routeEvent(frame('task_update', { agentId: 1, campaignId: 17 }), qc, SESSION_PROJECT_ID)
    expect(keys(invalidate)).toContainEqual(['campaign', 17])
  })

  it('falls back to broad campaign invalidation when campaignId is missing', () => {
    routeEvent(frame('campaign_status'), qc, SESSION_PROJECT_ID)
    expect(keys(invalidate)).toContainEqual(['campaign'])
    expect(keys(invalidate)).not.toContainEqual(['campaign', SESSION_PROJECT_ID])
  })
})

describe('routeEvent: system fan-out (no projectId scoping)', () => {
  let qc: QueryClient
  let invalidate: InvalidateMock
  beforeEach(() => {
    ;({ qc, invalidate } = makeClient())
  })

  it('system_health invalidates the unscoped system-health key', () => {
    routeEvent(frame('system_health', {}, 0), qc, SESSION_PROJECT_ID)
    expect(keys(invalidate)).toContainEqual(['system-health'])
  })

  it('does NOT scope system-health to the active project', () => {
    routeEvent(frame('system_health', {}, 0), qc, SESSION_PROJECT_ID)
    expect(keys(invalidate)).not.toContainEqual(['system-health', SESSION_PROJECT_ID])
  })
})

describe('routeEvent: invariants', () => {
  it('emits zero invalidations for an event with no registered routes', () => {
    const { qc, invalidate } = makeClient()
    routeEvent(
      { type: 'unmapped' as AppEvent['type'], projectId: 1, data: {}, timestamp: '' },
      qc,
      SESSION_PROJECT_ID
    )
    expect(keys(invalidate)).toEqual([])
  })

  it('never mutates the input frame', () => {
    const { qc } = makeClient()
    const f = frame('agent_status', { agentId: 1 })
    const snapshot = JSON.stringify(f)
    routeEvent(f, qc, SESSION_PROJECT_ID)
    expect(JSON.stringify(f)).toBe(snapshot)
  })
})

// ─── EVENT_TYPES completeness guard ──────────────────────────────────────────
//
// U2 introduced NotifyBus which transports existing AppEvent types — it did
// NOT add new variants. This guard asserts that the frontend EVENT_TYPES tuple
// covers the full backend event vocabulary (ProjectEventType + SystemEventType)
// so a backend addition that forgets to update the frontend is caught in CI.
//
// Note: this is a runtime list guard, not a cross-package type check. If the
// backend event union ever moves to a shared Zod schema exported from
// @hashhive/shared, replace these hardcoded strings with an import from that
// schema and assert set-equality against EVENT_TYPES.

describe('EVENT_TYPES completeness guard', () => {
  // Backend ProjectEventType members (from packages/backend/src/services/events.ts)
  const BACKEND_PROJECT_EVENT_TYPES = [
    'agent_status',
    'agent_error',
    'campaign_status',
    'task_update',
    'crack_result',
    'resource_update',
  ] as const

  // Backend SystemEventType members
  const BACKEND_SYSTEM_EVENT_TYPES = ['system_health'] as const

  const ALL_BACKEND_TYPES = [...BACKEND_PROJECT_EVENT_TYPES, ...BACKEND_SYSTEM_EVENT_TYPES] as const

  it('EVENT_TYPES covers every backend ProjectEventType', () => {
    for (const backendType of BACKEND_PROJECT_EVENT_TYPES) {
      expect(EVENT_TYPES).toContain(backendType)
    }
  })

  it('EVENT_TYPES covers every backend SystemEventType', () => {
    for (const backendType of BACKEND_SYSTEM_EVENT_TYPES) {
      expect(EVENT_TYPES).toContain(backendType)
    }
  })

  it('EVENT_TYPES length matches the full backend union (no orphaned frontend-only types)', () => {
    // If this fails, either the backend grew a new event type and the frontend
    // needs updating, or the frontend has a type with no backend counterpart.
    expect(EVENT_TYPES).toHaveLength(ALL_BACKEND_TYPES.length)
  })
})
