/**
 * Issue #97 U2 — durable preemption audit writer.
 *
 * Verifies `recordTaskEvent` maps its input onto the `task_events` insert
 * (with the documented null defaults) and surfaces DB failures rather than
 * swallowing them. The db layer is mocked with a values-capturing insert so
 * no real connection is needed.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test'

// Capture the object passed to `.insert(...).values(...)`.
let capturedValues: Record<string, unknown> | undefined
const returningMock = mock(() => Promise.resolve([{ id: 1 }]))
const valuesMock = mock((v: Record<string, unknown>) => {
  capturedValues = v
  return { returning: returningMock }
})
const insertMock = mock(() => ({ values: valuesMock }))

mock.module('../../../src/db/index.js', () => ({
  db: { insert: insertMock },
}))

const { recordTaskEvent } = await import('../../../src/services/tasks/task-events.js')

describe('recordTaskEvent', () => {
  beforeEach(() => {
    capturedValues = undefined
    valuesMock.mockClear()
    insertMock.mockClear()
    returningMock.mockReset().mockImplementation(() => Promise.resolve([{ id: 1 }]))
  })

  it('persists a preempted event with all fields populated', async () => {
    await recordTaskEvent({
      taskId: 42,
      eventType: 'preempted',
      fromStatus: 'running',
      toStatus: 'paused',
      reason: 'preempted',
      byCampaignId: 7,
    })

    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(capturedValues).toEqual({
      taskId: 42,
      eventType: 'preempted',
      fromStatus: 'running',
      toStatus: 'paused',
      reason: 'preempted',
      byCampaignId: 7,
    })
  })

  it('defaults reason and byCampaignId to null on a resumed event', async () => {
    await recordTaskEvent({
      taskId: 42,
      eventType: 'resumed',
      fromStatus: 'paused',
      toStatus: 'pending',
    })

    expect(capturedValues).toEqual({
      taskId: 42,
      eventType: 'resumed',
      fromStatus: 'paused',
      toStatus: 'pending',
      reason: null,
      byCampaignId: null,
    })
  })

  it('propagates a DB insert failure to the caller', async () => {
    returningMock.mockReset().mockImplementation(() => Promise.reject(new Error('db blip')))

    await expect(
      recordTaskEvent({
        taskId: 42,
        eventType: 'preempted',
        fromStatus: 'running',
        toStatus: 'paused',
      })
    ).rejects.toThrow('db blip')
  })
})
