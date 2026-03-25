import { type ConnectionOptions, Queue } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from '../config/logger.js';
import { QUEUE_NAMES, type QueueName } from '../config/queue.js';
import { createRedisClient, getRedisStatus } from '../config/redis.js';
import type { QueueJobMap } from './types.js';

export interface QueueHealth {
  status: 'connected' | 'disconnected';
  queues: Record<string, { waiting: number; active: number; failed: number }>;
}

/**
 * Manages BullMQ queues for the API process.
 * Responsible for enqueuing jobs and health reporting only.
 * Workers run in dedicated processes — see worker-*.ts entrypoints.
 */
export class QueueManager {
  private connection: Redis;
  private queues: Map<QueueName, Queue> = new Map();

  constructor() {
    this.connection = createRedisClient('bullmq');
  }

  async init(): Promise<void> {
    // Listen for the ready event so queues are created when Redis (re)connects
    // after a failed initial connection attempt.
    this.connection.on('ready', () => {
      if (this.queues.size === 0) {
        this.createQueues().catch((err) => {
          logger.error({ err }, 'Failed to create queues after Redis reconnect');
        });
      }
    });

    try {
      await this.connection.connect();
    } catch (err) {
      logger.warn({ err }, 'Redis not available at startup — queues will be created on reconnect');
      return;
    }

    // Only create if the ready handler hasn't already done it
    if (this.queues.size === 0) {
      await this.createQueues();
    }
  }

  private async createQueues(): Promise<void> {
    if (this.queues.size > 0) return;

    for (const name of Object.values(QUEUE_NAMES)) {
      // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
      this.queues.set(
        name,
        new Queue(name, { connection: this.connection as unknown as ConnectionOptions })
      );
    }

    // Schedule repeatable heartbeat monitor
    const heartbeatQueue = this.queues.get(QUEUE_NAMES.HEARTBEAT_MONITOR);
    if (heartbeatQueue) {
      await heartbeatQueue.upsertJobScheduler(
        'heartbeat-check',
        { every: 60_000 },
        { data: { triggeredAt: new Date().toISOString() } }
      );
    }

    logger.info('Queue manager initialized');
  }

  async enqueue<T extends QueueName>(
    queueName: T,
    data: QueueJobMap[T],
    opts?: { priority?: number }
  ): Promise<boolean> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      logger.warn({ queueName }, 'Queue not available — job not enqueued');
      return false;
    }

    try {
      await queue.add(queueName, data, {
        ...(opts?.priority ? { priority: opts.priority } : {}),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      });
      return true;
    } catch (err) {
      logger.error({ err, queueName }, 'Failed to enqueue job');
      return false;
    }
  }

  async getHealth(): Promise<QueueHealth> {
    const status = getRedisStatus(this.connection);

    if (status !== 'connected') {
      return { status: 'disconnected', queues: {} };
    }

    const queueStats: Record<string, { waiting: number; active: number; failed: number }> = {};

    for (const [name, queue] of this.queues) {
      try {
        const [waiting, active, failed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getFailedCount(),
        ]);
        queueStats[name] = { waiting, active, failed };
      } catch {
        queueStats[name] = { waiting: 0, active: 0, failed: 0 };
      }
    }

    return { status, queues: queueStats };
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down queue manager');

    // Close queues
    await Promise.all([...this.queues.values()].map((q) => q.close()));

    // Disconnect Redis
    this.connection.disconnect();

    logger.info('Queue manager shut down');
  }
}
