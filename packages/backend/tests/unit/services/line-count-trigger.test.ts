import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

// Resource lineCount lookups for enqueueLineCountForUncountedResources.
let lineCountValue: number | null = null
mock.module('../../../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ lineCount: lineCountValue }]) }),
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

  test('no-op when no queue manager is available', async () => {
    queueManager = null
    await enqueueLineCount('rulelist', 1, 1)
    expect(enqueueArgs).toEqual([])
  })

  test('swallows an enqueue failure', async () => {
    queueManager = {
      enqueue: () => Promise.reject(new Error('redis down')),
    }
    await expect(enqueueLineCount('wordlist', 1, 1)).resolves.toBeUndefined()
  })
})

describe('enqueueLineCountForUncountedResources', () => {
  test('enqueues for a wordlist that lacks a line count', async () => {
    lineCountValue = null
    await enqueueLineCountForUncountedResources({ wordlistId: 5, rulelistId: null, projectId: 3 })
    expect(enqueueArgs[2]).toEqual({ jobId: 'linecount:wordlist:5' })
  })

  test('does not enqueue when the resource is already counted', async () => {
    lineCountValue = 1000
    await enqueueLineCountForUncountedResources({ wordlistId: 5, rulelistId: null, projectId: 3 })
    expect(enqueueArgs).toEqual([])
  })

  test('no-op when the attack references no countable resource', async () => {
    await enqueueLineCountForUncountedResources({
      wordlistId: null,
      rulelistId: null,
      projectId: 3,
    })
    expect(enqueueArgs).toEqual([])
  })
})
