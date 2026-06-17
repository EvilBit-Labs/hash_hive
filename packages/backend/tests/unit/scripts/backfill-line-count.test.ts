import { maskLists, ruleLists, wordLists } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { LineCountResourceType } from '../../../src/services/resources/line-count-trigger.js'

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

// Table-aware select stub: the backfill queries wordLists then ruleLists and
// must never touch maskLists (masklists are sized by `keyspace`, not
// `line_count`, and have their own backfill — see #231). `fromTables` records
// which tables were queried so the masklist-exclusion assertion is real.
type FileRef = { bucket?: string; key?: string }
type CandidateRow = { id: number; projectId: number; fileRef: FileRef | null }
let wordlistRows: CandidateRow[] = []
let rulelistRows: CandidateRow[] = []
let fromTables: unknown[] = []
mock.module('../../../src/db/index.js', () => ({
  client: { end: mock(() => Promise.resolve()) },
  db: {
    select: () => ({
      from: (table: unknown) => {
        fromTables.push(table)
        return {
          where: () =>
            Promise.resolve(
              table === wordLists ? wordlistRows : table === ruleLists ? rulelistRows : []
            ),
        }
      },
    }),
  },
}))

const { enqueueLineCount, _lineCountDeps } =
  await import('../../../src/services/resources/line-count-trigger.js')
const { backfillLineCount, _backfillDeps } =
  await import('../../../src/scripts/backfill-line-count.js')

// Queue seam for the end-to-end jobId test (when the backfill delegates to the
// real `enqueueLineCount`). Mirrors tests/unit/services/line-count-trigger.test.ts.
let queueEnqueueCalls: unknown[][] = []
_lineCountDeps.getQueueContext = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({
    getQueueManager: () => ({
      enqueue: (...args: unknown[]) => {
        queueEnqueueCalls.push(args)
        return Promise.resolve(true)
      },
    }),
  } as any)
_lineCountDeps.getQueueConfig = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({ QUEUE_NAMES: { LINE_COUNT: 'jobs-line-count' } } as any)

// Default enqueue spy: captures (type, id, projectId) and reports success
// (mirrors enqueueLineCount's boolean return) without touching the queue.
let enqueueCalls: Array<[LineCountResourceType, number, number]> = []
function spyEnqueue(type: LineCountResourceType, id: number, projectId: number): Promise<boolean> {
  enqueueCalls.push([type, id, projectId])
  return Promise.resolve(true)
}

beforeEach(() => {
  wordlistRows = []
  rulelistRows = []
  fromTables = []
  enqueueCalls = []
  queueEnqueueCalls = []
  _backfillDeps.enqueue = spyEnqueue
})

const withKey = (id: number, projectId: number): CandidateRow => ({
  id,
  projectId,
  fileRef: { bucket: 'resources', key: `k/${id}` },
})

describe('backfillLineCount', () => {
  test('enqueues one job per uncounted ready wordlist and rulelist', async () => {
    wordlistRows = [withKey(1, 10), withKey(2, 10)]
    rulelistRows = [withKey(3, 20)]

    const summary = await backfillLineCount()

    expect(enqueueCalls).toEqual([
      ['wordlist', 1, 10],
      ['wordlist', 2, 10],
      ['rulelist', 3, 20],
    ])
    expect(summary).toEqual({ total: 3, enqueued: 3, skipped: [], failed: [] })
  })

  test('forwards the resource projectId verbatim to the enqueue', async () => {
    wordlistRows = [withKey(7, 99)]

    await backfillLineCount()

    expect(enqueueCalls).toEqual([['wordlist', 7, 99]])
  })

  test('delegates to enqueueLineCount with the dedup jobId end to end', async () => {
    _backfillDeps.enqueue = enqueueLineCount
    wordlistRows = [withKey(42, 7)]

    await backfillLineCount()

    expect(queueEnqueueCalls).toHaveLength(1)
    expect(queueEnqueueCalls[0][0]).toBe('jobs-line-count')
    expect(queueEnqueueCalls[0][1]).toEqual({
      resourceType: 'wordlist',
      resourceId: 42,
      projectId: 7,
    })
    expect(queueEnqueueCalls[0][2]).toEqual({ jobId: 'linecount:wordlist:42' })
  })

  test('no candidates: enqueues nothing and reports an empty run', async () => {
    const summary = await backfillLineCount()

    expect(enqueueCalls).toEqual([])
    expect(summary).toEqual({ total: 0, enqueued: 0, skipped: [], failed: [] })
  })

  test('never queries the masklist table', async () => {
    wordlistRows = [withKey(1, 10)]

    await backfillLineCount()

    expect(fromTables).toContain(wordLists)
    expect(fromTables).toContain(ruleLists)
    expect(fromTables).not.toContain(maskLists)
  })

  test('skips a candidate whose file reference has no key, without enqueuing it', async () => {
    wordlistRows = [withKey(1, 10), { id: 2, projectId: 10, fileRef: {} }]

    const summary = await backfillLineCount()

    expect(enqueueCalls).toEqual([['wordlist', 1, 10]])
    expect(summary.skipped).toEqual(['wordlist:2'])
    expect(summary.enqueued).toBe(1)
    expect(summary.failed).toEqual([])
  })

  test('one row enqueue failure is recorded and does not abort the run', async () => {
    _backfillDeps.enqueue = (type, id, projectId) => {
      if (id === 2) return Promise.reject(new Error('redis down'))
      return spyEnqueue(type, id, projectId)
    }
    wordlistRows = [withKey(1, 10), withKey(2, 10), withKey(3, 10)]

    const summary = await backfillLineCount()

    expect(enqueueCalls).toEqual([
      ['wordlist', 1, 10],
      ['wordlist', 3, 10],
    ])
    expect(summary.failed).toEqual(['wordlist:2'])
    expect(summary.enqueued).toBe(2)
    expect(summary.total).toBe(3)
  })

  test('records a row as failed when the enqueue reports not enqueued (queue unavailable)', async () => {
    // enqueueLineCount returns false (rather than throwing) when the queue is
    // unavailable — counting it as enqueued would mask a silent no-op.
    _backfillDeps.enqueue = (type, id, projectId) => {
      if (id === 2) return Promise.resolve(false)
      return spyEnqueue(type, id, projectId)
    }
    wordlistRows = [withKey(1, 10), withKey(2, 10), withKey(3, 10)]

    const summary = await backfillLineCount()

    expect(enqueueCalls).toEqual([
      ['wordlist', 1, 10],
      ['wordlist', 3, 10],
    ])
    expect(summary.failed).toEqual(['wordlist:2'])
    expect(summary.enqueued).toBe(2)
    expect(summary.total).toBe(3)
  })
})
