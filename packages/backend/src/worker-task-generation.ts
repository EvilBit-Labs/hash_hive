import { logger } from './config/logger.js'
import { QUEUE_NAMES, TASK_PRIORITY_QUEUES } from './config/queue.js'
import { createRedisClient } from './config/redis.js'
import { createTaskGeneratorWorker } from './queue/workers/task-generator.js'

const connection = createRedisClient('task-generation-worker')

async function main() {
  await connection.connect()
  logger.info('Task generation worker connected to Redis')

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
