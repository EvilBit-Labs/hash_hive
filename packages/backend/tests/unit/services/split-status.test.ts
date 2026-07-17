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

import { deriveSplitStatus } from '../../../src/services/campaign-split-status.js'

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

  it('no children, job failed -> failed with the failure reason', () => {
    expect(
      deriveSplitStatus(false, jobInfo({ state: 'failed', failedReason: 'DB connection lost' }))
    ).toEqual({ status: 'failed', message: 'DB connection lost' })
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
