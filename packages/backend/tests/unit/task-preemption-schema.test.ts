/**
 * Issue #97 U1 — schema foundation for task preemption.
 *
 * Pure unit coverage for the shared wire/bucket contract introduced by
 * the `paused` task status: the dashboard bucket mapping, the
 * `pausedReason` vocabulary, and the `task_events` audit shape. The DB
 * columns + CHECK constraints are exercised end-to-end by the migration
 * itself (`just db-migrate`) and by U3/U6 service tests.
 */
import {
  type TaskDbStatus,
  TASK_DB_TO_BUCKET,
  pausedReasonSchema,
  taskDbStatusSchema,
  taskEventSchema,
} from '@hashhive/shared'
import { describe, expect, it } from 'bun:test'

describe('taskDbStatusSchema includes paused', () => {
  it('accepts the new paused literal', () => {
    expect(taskDbStatusSchema.parse('paused')).toBe('paused')
  })

  it('rejects an unknown status literal', () => {
    expect(() => taskDbStatusSchema.parse('halted')).toThrow()
  })
})

describe('TASK_DB_TO_BUCKET', () => {
  it('maps paused into the pending bucket', () => {
    expect(TASK_DB_TO_BUCKET.paused).toBe('pending')
  })

  it('assigns a bucket to every persisted task status', () => {
    for (const status of taskDbStatusSchema.options) {
      expect(TASK_DB_TO_BUCKET[status as TaskDbStatus]).toBeDefined()
    }
  })

  it('keeps remaining = total - completed - failed with paused rows counted as pending', () => {
    // Arrange: one row per status, total = 8.
    const rows: TaskDbStatus[] = [
      'pending',
      'assigned',
      'running',
      'paused',
      'completed',
      'exhausted',
      'failed',
      'cancelled',
    ]

    // Act: bucket the rows.
    const counts = { pending: 0, running: 0, completed: 0, failed: 0 }
    for (const status of rows) counts[TASK_DB_TO_BUCKET[status]]++

    // Assert: paused joined pending; the ETA identity still holds.
    const total = rows.length
    expect(counts.pending).toBe(2) // pending + paused
    expect(counts.running).toBe(2) // assigned + running
    expect(counts.completed).toBe(2) // completed + exhausted
    expect(counts.failed).toBe(2) // failed + cancelled
    expect(total - counts.completed - counts.failed).toBe(counts.pending + counts.running)
  })
})

describe('pausedReasonSchema', () => {
  it('accepts the two canonical reasons', () => {
    expect(pausedReasonSchema.parse('preempted')).toBe('preempted')
    expect(pausedReasonSchema.parse('campaign_paused')).toBe('campaign_paused')
  })

  it('rejects an unknown reason', () => {
    expect(() => pausedReasonSchema.parse('user')).toThrow()
  })
})

describe('taskEventSchema', () => {
  it('parses a preempted audit row and coerces createdAt to a Date', () => {
    const parsed = taskEventSchema.parse({
      id: 1,
      taskId: 42,
      eventType: 'preempted',
      reason: 'preempted',
      fromStatus: 'running',
      toStatus: 'paused',
      byCampaignId: 7,
      createdAt: '2026-06-14T00:00:00.000Z',
    })
    expect(parsed.eventType).toBe('preempted')
    expect(parsed.createdAt).toBeInstanceOf(Date)
  })

  it('allows null reason and null linkage on a resumed row', () => {
    const parsed = taskEventSchema.parse({
      id: 2,
      taskId: 42,
      eventType: 'resumed',
      reason: null,
      fromStatus: 'paused',
      toStatus: 'pending',
      byCampaignId: null,
      createdAt: '2026-06-14T00:01:00.000Z',
    })
    expect(parsed.eventType).toBe('resumed')
    expect(parsed.reason).toBeNull()
  })
})
