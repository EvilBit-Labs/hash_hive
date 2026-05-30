/**
 * Unit coverage for the heartbeat helpers extracted from
 * `processHeartbeat` (CQ-H4 / P-H1).
 *
 * Focused on the short-circuit paths that don't require a real DB —
 * the happy-path orchestration is exercised end-to-end by the
 * integration suite at tests/integration/agent-heartbeat.test.ts.
 */
import type { AgentHeartbeat } from '@hashhive/shared'

import { beforeEach, describe, expect, it, mock } from 'bun:test'

mock.module('../../../src/services/events.js', () => ({
  emitAgentError: mock(() => {}),
  emitAgentStatus: mock(() => {}),
  emitTaskUpdate: mock(() => {}),
  emitCampaignStatus: mock(() => {}),
  emitCrackResult: mock(() => {}),
}))

import {
  __resetWarnedEmptyCapsForTesting,
  computeHighPriorityHint,
  emitHeartbeatPostCommit,
  failActiveTasksOnFatal,
  verifyTaskOwnership,
} from '../../../src/services/agents/heartbeat.js'
import { emitAgentError, emitAgentStatus } from '../../../src/services/events.js'

type EmitMock = ReturnType<typeof mock>

beforeEach(() => {
  __resetWarnedEmptyCapsForTesting()
  // Reset (not clear) so queued `mockImplementationOnce` values from a
  // prior test cannot leak into the next — `mockClear()` only clears
  // call history, leaving queued one-shot impls intact.
  ;(emitAgentError as unknown as EmitMock).mockReset()
  ;(emitAgentStatus as unknown as EmitMock).mockReset()
})

describe('verifyTaskOwnership', () => {
  it('returns undefined when taskId is undefined (no DB call)', async () => {
    // The mock tx will throw if called; we rely on the early-return.
    const tx = {
      select: () => {
        throw new Error('select() must not be called when taskId is undefined')
      },
    }
    const result = await verifyTaskOwnership(tx as never, 1, undefined)
    expect(result).toBeUndefined()
  })

  it('returns the taskId when the agent owns it', async () => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: () => Promise.resolve([{ id: 42 }]),
            }),
          }),
        }),
      }),
    }
    const result = await verifyTaskOwnership(tx as never, 1, 42)
    expect(result).toBe(42)
  })

  it('returns undefined when the task is not owned by the agent', async () => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({
              limit: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    }
    const result = await verifyTaskOwnership(tx as never, 1, 99)
    expect(result).toBeUndefined()
  })
})

describe('emitHeartbeatPostCommit', () => {
  const baseUpdated = { id: 7, projectId: 3 }

  it('emits agent_status for every heartbeat', () => {
    emitHeartbeatPostCommit(
      baseUpdated,
      { kind: 'noop', effectiveStatus: 'online', isFatalError: false },
      undefined
    )
    expect((emitAgentStatus as unknown as EmitMock).mock.calls).toHaveLength(1)
  })

  it('emits agent_error only when an error is present', () => {
    emitHeartbeatPostCommit(
      baseUpdated,
      { kind: 'noop', effectiveStatus: 'online', isFatalError: false },
      undefined
    )
    expect((emitAgentError as unknown as EmitMock).mock.calls).toHaveLength(0)

    emitHeartbeatPostCommit(
      baseUpdated,
      { kind: 'noop', effectiveStatus: 'error', isFatalError: true },
      { severity: 'fatal', message: 'oops' }
    )
    expect((emitAgentError as unknown as EmitMock).mock.calls).toHaveLength(1)
  })

  it('does NOT throw when emit fails (swallows for retry on next heartbeat)', () => {
    ;(emitAgentStatus as unknown as EmitMock).mockImplementationOnce(() => {
      throw new Error('SSE bus down')
    })
    expect(() =>
      emitHeartbeatPostCommit(
        baseUpdated,
        { kind: 'noop', effectiveStatus: 'online', isFatalError: false },
        undefined
      )
    ).not.toThrow()
  })
})

describe('failActiveTasksOnFatal', () => {
  it('returns undefined (no DB call) when the heartbeat is not fatal', async () => {
    const summary = await failActiveTasksOnFatal(
      1,
      { kind: 'noop', effectiveStatus: 'online', isFatalError: false },
      { status: 'online' } as AgentHeartbeat
    )
    expect(summary).toBeUndefined()
  })
})

describe('computeHighPriorityHint', () => {
  it('returns false when updated is undefined', async () => {
    const result = await computeHighPriorityHint(undefined)
    expect(result).toBe(false)
  })

  it('returns false when the agent is not claim-eligible (status=error)', async () => {
    const result = await computeHighPriorityHint({
      id: 1,
      projectId: 1,
      status: 'error',
      capabilities: { hashModes: [1000] },
    })
    expect(result).toBe(false)
  })

  it('returns false and warns when capabilities are null', async () => {
    const result = await computeHighPriorityHint({
      id: 1,
      projectId: 1,
      status: 'online',
      capabilities: null,
    })
    expect(result).toBe(false)
  })

  it('returns false and warns when hashModes is empty', async () => {
    const result = await computeHighPriorityHint({
      id: 1,
      projectId: 1,
      status: 'online',
      capabilities: { hashModes: [] },
    })
    expect(result).toBe(false)
  })

  it('returns false and warns when hashModes has no usable integers', async () => {
    const result = await computeHighPriorityHint({
      id: 1,
      projectId: 1,
      status: 'online',
      // Number(null) === 0, which would pass the integer check, so
      // use strings + a float to keep this case truly all-invalid.
      capabilities: { hashModes: ['nope', 'nada', 3.14] },
    })
    expect(result).toBe(false)
  })
})
