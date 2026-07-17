import { describe, expect, it } from 'bun:test'

/**
 * Unit tests for `deriveSplitStatus` (issue #202 SU7) — the pure decision
 * function behind the async split-status poll. No DB connection, no
 * mock.module, no IS_ISOLATED env gate. Runs in the shared `bun test` phase
 * (mirrors tests/unit/services/split-analysis.test.ts).
 *
 * `getSplitStatus` itself (the DB + QueueManager wiring around this
 * function) is exercised in `tests/db/campaign-split-create.db.test.ts`,
 * including a stubbed-QueueManager test proving a completed
 * `degenerate-empty` job actually round-trips through `QueueManager.getJobInfo`
 * to a `status: 'empty'` response — this file only covers the pure logic.
 */
import type { QueueJobInfo } from '../../../src/queue/manager.js'

import {
  deriveSplitStatus,
  sanitizeSplitError,
} from '../../../src/services/campaign-split-status.js'

function jobInfo(overrides: Partial<QueueJobInfo>): QueueJobInfo {
  return { state: 'completed', returnvalue: null, failedReason: null, ...overrides }
}

describe('deriveSplitStatus', () => {
  it('hasChildren=true -> ready, regardless of job info', () => {
    expect(deriveSplitStatus(true, null)).toEqual({ status: 'ready', message: null })
    expect(deriveSplitStatus(true, jobInfo({ state: 'failed', failedReason: 'boom' }))).toEqual({
      status: 'ready',
      message: null,
    })
  })

  it('no children, no job info -> pending (never enqueued, or evicted with nothing to show)', () => {
    expect(deriveSplitStatus(false, null)).toEqual({ status: 'pending', message: null })
  })

  it('no children, job active/waiting/delayed -> pending', () => {
    for (const state of ['active', 'waiting', 'delayed', 'waiting-children', 'paused', 'unknown']) {
      expect(deriveSplitStatus(false, jobInfo({ state }))).toEqual({
        status: 'pending',
        message: null,
      })
    }
  })

  it('no children, job failed -> failed with a SANITIZED message, never the raw failedReason', () => {
    // Code review fix: `failedReason` is BullMQ's copy of the raw thrown
    // Error.message — for a Postgres/Drizzle failure that can embed SQL,
    // table, and column names, which must never round-trip straight to the
    // dashboard client. A generic-sounding raw reason like "DB connection
    // lost" isn't itself sensitive, but the point is the wire message must
    // ALWAYS be the sanitized string, not a pass-through of whatever the
    // worker happened to throw.
    const result = deriveSplitStatus(
      false,
      jobInfo({ state: 'failed', failedReason: 'DB connection lost' })
    )
    expect(result.status).toBe('failed')
    expect(result.message).toBe(sanitizeSplitError('DB connection lost'))
    expect(result.message).not.toBe('DB connection lost')
  })

  it('no children, job failed with no failedReason -> failed with a fallback message', () => {
    const result = deriveSplitStatus(false, jobInfo({ state: 'failed', failedReason: null }))
    expect(result.status).toBe('failed')
    expect(result.message).not.toBeNull()
  })

  it('no children, job completed with degenerate-empty -> empty with a message', () => {
    const result = deriveSplitStatus(
      false,
      jobInfo({ state: 'completed', returnvalue: { outcome: 'degenerate-empty', subLists: [] } })
    )
    expect(result.status).toBe('empty')
    expect(result.message).not.toBeNull()
  })

  it('no children, job completed with degenerate-single-group -> single_group, no message', () => {
    expect(
      deriveSplitStatus(
        false,
        jobInfo({
          state: 'completed',
          returnvalue: { outcome: 'degenerate-single-group', subLists: [] },
        })
      )
    ).toEqual({ status: 'single_group', message: null })
  })

  it('no children, job completed with split/already-split -> pending (race: children not visible to this read yet)', () => {
    expect(
      deriveSplitStatus(
        false,
        jobInfo({ state: 'completed', returnvalue: { outcome: 'split', subLists: [] } })
      )
    ).toEqual({ status: 'pending', message: null })
    expect(
      deriveSplitStatus(
        false,
        jobInfo({ state: 'completed', returnvalue: { outcome: 'already-split', subLists: [] } })
      )
    ).toEqual({ status: 'pending', message: null })
  })

  it('no children, job completed with an unrecognized returnvalue shape -> pending, never throws', () => {
    expect(deriveSplitStatus(false, jobInfo({ state: 'completed', returnvalue: null }))).toEqual({
      status: 'pending',
      message: null,
    })
    expect(
      deriveSplitStatus(false, jobInfo({ state: 'completed', returnvalue: { outcome: 42 } }))
    ).toEqual({ status: 'pending', message: null })
    expect(
      deriveSplitStatus(false, jobInfo({ state: 'completed', returnvalue: 'not-an-object' }))
    ).toEqual({ status: 'pending', message: null })
  })
})

describe('sanitizeSplitError', () => {
  it('null failedReason -> generic fallback', () => {
    expect(sanitizeSplitError(null)).toBe('Split analysis failed')
  })

  it('a "hash list ... not found" message -> Hash list not found', () => {
    expect(sanitizeSplitError('Hash list 42 not found')).toBe('Hash list not found')
  })

  it('a connectivity-flavored message -> Storage backend unavailable', () => {
    expect(sanitizeSplitError('connect ECONNREFUSED 127.0.0.1:5432')).toBe(
      'Storage backend unavailable'
    )
    expect(sanitizeSplitError('Request timeout after 30000ms')).toBe('Storage backend unavailable')
  })

  it('never leaks raw SQL/internal text — unrecognized reasons collapse to the generic default', () => {
    expect(
      sanitizeSplitError(
        'insert into "hash_items" ("hash_list_id","hash_value") values ($1,$2) - duplicate key value violates unique constraint "hash_items_pkey"'
      )
    ).toBe('Split analysis failed')
    expect(sanitizeSplitError('split-worker: confident group is missing a hashcat mode')).toBe(
      'Split analysis failed'
    )
  })
})
