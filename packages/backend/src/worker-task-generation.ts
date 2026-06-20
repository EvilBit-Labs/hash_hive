import type { NotifyBus } from './services/events/notify-bus.js'

import { logger } from './config/logger.js'
import { QUEUE_NAMES, TASK_PRIORITY_QUEUES } from './config/queue.js'
import { createRedisClient } from './config/redis.js'
import { createTaskGeneratorWorker } from './queue/workers/task-generator.js'

const connection = createRedisClient('task-generation-worker')

let notifyBus: NotifyBus<object> | null = null

async function main() {
  await connection.connect()
  logger.info('Task generation worker connected to Redis')

  // Publisher-only NotifyBus: forwards task-generation events to the API
  // process via pg_notify. No listen connection is opened.
  try {
    const { createNotifyBus } = await import('./services/events/notify-bus.js')
    notifyBus = await createNotifyBus('worker')
    await notifyBus.start()
    logger.info('NotifyBus started (task-generation-worker/publisher role)')
  } catch (err) {
    logger.error({ err }, 'NotifyBus init failed — worker events will not reach API process')
  }

  // Start a worker for each priority queue (high, normal, low).
  // Each worker processes its queue independently so higher-priority
  // campaigns are never blocked behind lower-priority ones.
  const workers = TASK_PRIORITY_QUEUES.map((queueName) => {
    const worker = createTaskGeneratorWorker(connection, queueName)
    logger.info({ queue: queueName }, 'Task generation worker started')
    return worker
  })

  // Also consume the dedicated task-generation job queue for hybrid generation
  const dedicatedWorker = createTaskGeneratorWorker(connection, QUEUE_NAMES.TASK_GENERATION)
  logger.info(
    { queue: QUEUE_NAMES.TASK_GENERATION },
    'Task generation worker started (dedicated queue)'
  )
  workers.push(dedicatedWorker)

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down task generation workers')
    if (notifyBus) {
      await notifyBus.stop()
    }
    await Promise.all(workers.map((w) => w.close()))
    connection.disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error({ err }, 'Task generation worker failed to start')
  process.exit(1)
})
