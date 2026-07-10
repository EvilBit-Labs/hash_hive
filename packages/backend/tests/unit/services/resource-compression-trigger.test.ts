/**
 * Unit tests for `enqueueResourceCompression` (issue #108 U4, plus the
 * task-resources gate-hole review: this enqueue is now also the self-heal
 * path for `getResourcesForTask`'s not-ready 409, so a silently-swallowed
 * failure here would wedge a task behind a permanent 409). Mirrors
 * `line-count-trigger.test.ts`'s `_deps` seam pattern exactly -- the
 * `_resourceCompressionDeps` dynamic-import seam is monkey-patched directly
 * (not via `mock.module`, which can't override an already-cached dynamic
 * import across files) so the queue manager can be swapped out per test
 * without a live Redis.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../../src/config/logger.js', () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}))

const { enqueueResourceCompression, _resourceCompressionDeps } =
  await import('../../../src/services/resources/resource-compression-trigger.js')
const { logger } = await import('../../../src/config/logger.js')

// Captured enqueue calls + a switch to simulate a missing queue manager,
// a declined enqueue, or an enqueue throw.
let enqueueArgs: unknown[] = []
let queueManager: { enqueue: (...args: unknown[]) => Promise<boolean> } | null = null
_resourceCompressionDeps.getQueueContext = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({ getQueueManager: () => queueManager } as any)
_resourceCompressionDeps.getQueueConfig = () =>
  // oxlint-disable-next-line no-explicit-any -- test stub for the dynamic-import seam
  Promise.resolve({ QUEUE_NAMES: { RESOURCE_COMPRESSION: 'jobs-resource-compression' } } as any)

beforeEach(() => {
  enqueueArgs = []
  ;(logger.warn as ReturnType<typeof mock>).mockClear()
  queueManager = {
    enqueue: (...args: unknown[]) => {
      enqueueArgs = args
      return Promise.resolve(true)
    },
  }
})

describe('enqueueResourceCompression', () => {
  test('enqueues with the dedup jobId via QueueManager.enqueue', async () => {
    const enqueued = await enqueueResourceCompression('wordlist', 42, 7)

    expect(enqueued).toBe(true)
    expect(enqueueArgs[0]).toBe('jobs-resource-compression')
    expect(enqueueArgs[1]).toEqual({ resourceType: 'wordlist', resourceId: 42, projectId: 7 })
    expect(enqueueArgs[2]).toEqual({ jobId: 'compress:wordlist:42' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('returns false and logs when no queue manager is available', async () => {
    queueManager = null

    const enqueued = await enqueueResourceCompression('rulelist', 1, 1)

    expect(enqueued).toBe(false)
    expect(enqueueArgs).toEqual([])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { resourceType: 'rulelist', resourceId: 1 },
      expect.stringContaining('no queue manager available')
    )
  })

  test('returns false and logs when the queue manager declines the enqueue', async () => {
    queueManager = { enqueue: () => Promise.resolve(false) }

    const enqueued = await enqueueResourceCompression('masklist', 8, 3)

    expect(enqueued).toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { resourceType: 'masklist', resourceId: 8 },
      expect.stringContaining('declined the job')
    )
  })

  test('swallows an enqueue failure, reports it as not enqueued, and logs', async () => {
    queueManager = {
      enqueue: () => Promise.reject(new Error('redis down')),
    }

    await expect(enqueueResourceCompression('wordlist', 1, 1)).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), resourceType: 'wordlist', resourceId: 1 },
      'failed to enqueue resource-compression job'
    )
  })
})
