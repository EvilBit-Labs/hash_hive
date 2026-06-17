import { maskLists } from '@hashhive/shared'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

// Resource sizing lookups for enqueueLineCountForUncountedResources:
// wordlist/rulelist read lineCount; masklist reads keyspace (#231).
let lineCountValue: number | null = null
let maskKeyspaceValue: string | null = null
mock.module('../../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              table === maskLists ? { keyspace: maskKeyspaceValue } : { lineCount: lineCountValue },
            ]),
        }),
      }),
    }),
  },
}))

const { enqueueLineCount, enqueueLineCountForUncountedResources, _lineCountDeps } =
  await import('../../../src/services/resources/line-count-trigger.js')

// Captured enqueue calls + a switch to simulate a missing queue manager / throw.
let enqueueArgs: unknown[] = []
let queueManager: { enqueue: (...args: unknown[]) => Promise<boolean> } | null = null
_lineCountDeps.getQueueContext = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({ getQueueManager: () => queueManager } as any)
_lineCountDeps.getQueueConfig = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({ QUEUE_NAMES: { LINE_COUNT: 'jobs-line-count' } } as any)

beforeEach(() => {
  enqueueArgs = []
  lineCountValue = null
  maskKeyspaceValue = null
  queueManager = {
    enqueue: (...args: unknown[]) => {
      enqueueArgs = args
      return Promise.resolve(true)
    },
  }
})

describe('enqueueLineCount', () => {
  test('enqueues with the dedup jobId via QueueManager.enqueue', async () => {
    await enqueueLineCount('wordlist', 42, 7)
    expect(enqueueArgs[0]).toBe('jobs-line-count')
    expect(enqueueArgs[1]).toEqual({ resourceType: 'wordlist', resourceId: 42, projectId: 7 })
    expect(enqueueArgs[2]).toEqual({ jobId: 'linecount:wordlist:42' })
  })

  test('returns false and no-ops when no queue manager is available', async () => {
    queueManager = null
    const enqueued = await enqueueLineCount('rulelist', 1, 1)
    expect(enqueued).toBe(false)
    expect(enqueueArgs).toEqual([])
  })

  test('swallows an enqueue failure and reports it as not enqueued', async () => {
    queueManager = {
      enqueue: () => Promise.reject(new Error('redis down')),
    }
    await expect(enqueueLineCount('wordlist', 1, 1)).resolves.toBe(false)
  })
})

describe('enqueueLineCountForUncountedResources', () => {
  test('enqueues for a wordlist that lacks a line count', async () => {
    lineCountValue = null
    await enqueueLineCountForUncountedResources({
      wordlistId: 5,
      rulelistId: null,
      masklistId: null,
      projectId: 3,
    })
    expect(enqueueArgs[2]).toEqual({ jobId: 'linecount:wordlist:5' })
  })

  test('does not enqueue when the resource is already counted', async () => {
    lineCountValue = 1000
    await enqueueLineCountForUncountedResources({
      wordlistId: 5,
      rulelistId: null,
      masklistId: null,
      projectId: 3,
    })
    expect(enqueueArgs).toEqual([])
  })

  test('enqueues for a masklist that lacks a summed keyspace (#231)', async () => {
    maskKeyspaceValue = null
    await enqueueLineCountForUncountedResources({
      wordlistId: null,
      rulelistId: null,
      masklistId: 8,
      projectId: 3,
    })
    expect(enqueueArgs[1]).toEqual({ resourceType: 'masklist', resourceId: 8, projectId: 3 })
    expect(enqueueArgs[2]).toEqual({ jobId: 'linecount:masklist:8' })
  })

  test('does not enqueue when the masklist keyspace is already computed', async () => {
    maskKeyspaceValue = '1676'
    await enqueueLineCountForUncountedResources({
      wordlistId: null,
      rulelistId: null,
      masklistId: 8,
      projectId: 3,
    })
    expect(enqueueArgs).toEqual([])
  })

  test('no-op when the attack references no countable resource', async () => {
    await enqueueLineCountForUncountedResources({
      wordlistId: null,
      rulelistId: null,
      masklistId: null,
      projectId: 3,
    })
    expect(enqueueArgs).toEqual([])
  })
})
