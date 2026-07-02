import type Redis from 'ioredis'

import { type ConnectionOptions, Queue } from 'bullmq'

import type { QueueJobMap } from './types.js'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { DEFAULT_JOB_ATTEMPTS, QUEUE_NAMES, type QueueName } from '../config/queue.js'
import { createRedisClient, getRedisStatus } from '../config/redis.js'
import { AUDIT_RETENTION_SCHEDULER_INTERVAL_MS } from './workers/audit-retention.js'
import { BLOB_RECLAMATION_SCHEDULER_INTERVAL_MS } from './workers/blob-reclamation.js'

export interface QueueHealth {
  status: 'connected' | 'disconnected'
  queues: Record<string, { waiting: number; active: number; failed: number }>
}

/**
 * Heartbeat-monitor scheduler cadence. Must stay strictly shorter than the
 * 5-minute offline threshold in `queue/workers/heartbeat-monitor.ts` and
 * the 5-minute default `staleThresholdMs` in `services/tasks.ts` so a
 * stale task is caught within roughly one tick after it crosses the
 * threshold. Increasing this without bumping the assigned-at floor in
 * `reassignStaleTasks` would reintroduce the first-heartbeat race.
 */
export const HEARTBEAT_SCHEDULER_INTERVAL_MS = 2 * 60 * 1000

/**
 * Manages BullMQ queues for the API process.
 * Responsible for enqueuing jobs and health reporting only.
 * Workers run in dedicated processes — see worker-*.ts entrypoints.
 */
export class QueueManager {
  private connection: Redis
  private queues: Map<QueueName, Queue> = new Map()

  constructor() {
    this.connection = createRedisClient('bullmq')
  }

  async init(): Promise<void> {
    // Listen for the ready event so queues are created when Redis (re)connects
    // after a failed initial connection attempt.
    this.connection.on('ready', () => {
      if (this.queues.size === 0) {
        this.createQueues().catch((err) => {
          logger.error({ err }, 'Failed to create queues after Redis reconnect')
        })
      }
    })

    try {
      await this.connection.connect()
    } catch (err) {
      logger.warn({ err }, 'Redis not available at startup — queues will be created on reconnect')
      return
    }

    // Only create if the ready handler hasn't already done it
    if (this.queues.size === 0) {
      await this.createQueues()
    }
  }

  private async createQueues(): Promise<void> {
    if (this.queues.size > 0) return

    for (const name of Object.values(QUEUE_NAMES)) {
      // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
      this.queues.set(
        name,
        new Queue(name, {
          connection: this.connection as unknown as ConnectionOptions,
        })
      )
    }

    // Schedule repeatable heartbeat monitor. See HEARTBEAT_SCHEDULER_INTERVAL_MS
    // for the rationale on the relationship to the offline threshold.
    const heartbeatQueue = this.queues.get(QUEUE_NAMES.HEARTBEAT_MONITOR)
    if (heartbeatQueue) {
      await heartbeatQueue.upsertJobScheduler(
        'heartbeat-check',
        { every: HEARTBEAT_SCHEDULER_INTERVAL_MS },
        { data: { triggeredAt: new Date().toISOString() } }
      )
    }

    // Schedule repeatable health monitor (issue #109).
    const healthQueue = this.queues.get(QUEUE_NAMES.HEALTH_MONITOR)
    if (healthQueue) {
      await healthQueue.upsertJobScheduler(
        'health-check',
        { every: env.HEALTH_MONITOR_INTERVAL_MS },
        { data: { triggeredAt: new Date().toISOString() } }
      )
    }

    // Schedule daily audit-log retention sweep (U9).
    const auditRetentionQueue = this.queues.get(QUEUE_NAMES.AUDIT_RETENTION)
    if (auditRetentionQueue) {
      await auditRetentionQueue.upsertJobScheduler(
        'audit-retention-sweep',
        { every: AUDIT_RETENTION_SCHEDULER_INTERVAL_MS },
        { data: { triggeredAt: new Date().toISOString() } }
      )
    }

    // Schedule daily blob-reclamation sweep (issue #106 U11).
    const blobReclamationQueue = this.queues.get(QUEUE_NAMES.BLOB_RECLAMATION)
    if (blobReclamationQueue) {
      await blobReclamationQueue.upsertJobScheduler(
        'blob-reclamation-sweep',
        { every: BLOB_RECLAMATION_SCHEDULER_INTERVAL_MS },
        { data: { triggeredAt: new Date().toISOString() } }
      )
    }

    logger.info('Queue manager initialized')
  }

  async enqueue<T extends QueueName>(
    queueName: T,
    data: QueueJobMap[T],
    opts?: { priority?: number; jobId?: string }
  ): Promise<boolean> {
    const queue = this.queues.get(queueName)
    if (!queue) {
      logger.warn({ queueName }, 'Queue not available — job not enqueued')
      return false
    }

    try {
      // `jobId` enables per-key dedup: BullMQ treats a re-add with an
      // existing jobId as a no-op, so a burst of triggers for one project
      // collapses to a single job. CRITICAL: a deduped job MUST also set
      // removeOnComplete/removeOnFail — BullMQ retains terminal jobs and
      // keeps their jobId key alive, so without eviction the *first* run
      // permanently blocks every future re-add (preemption would fire once
      // per project then silently never again).
      await queue.add(queueName, data, {
        ...(opts?.priority ? { priority: opts.priority } : {}),
        ...(opts?.jobId ? { jobId: opts.jobId, removeOnComplete: true, removeOnFail: true } : {}),
        attempts: DEFAULT_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
      })
      return true
    } catch (err) {
      logger.error({ err, queueName }, 'Failed to enqueue job')
      return false
    }
  }

  /**
   * Returns the Redis connection status without iterating every queue.
   * Used by the system-health probe (issue #109) so probeRedis and
   * probeQueues don't both call the heavier qm.getHealth() and double
   * the Redis round-trips per health request.
   */
  getRedisStatus(): 'connected' | 'disconnected' {
    return getRedisStatus(this.connection)
  }

  async getHealth(): Promise<QueueHealth> {
    const status = getRedisStatus(this.connection)

    if (status !== 'connected') {
      return { status: 'disconnected', queues: {} }
    }

    const queueStats: Record<string, { waiting: number; active: number; failed: number }> = {}

    for (const [name, queue] of this.queues) {
      try {
        const [waiting, active, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getFailedCount(),
        ])
        queueStats[name] = { waiting, active, failed }
      } catch {
        queueStats[name] = { waiting: 0, active: 0, failed: 0 }
      }
    }

    return { status, queues: queueStats }
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down queue manager')

    // Close queues
    await Promise.all([...this.queues.values()].map((q) => q.close()))

    // Disconnect Redis
    this.connection.disconnect()

    logger.info('Queue manager shut down')
  }
}
