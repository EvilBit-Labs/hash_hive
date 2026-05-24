import { logger } from './config/logger.js'
import { createRedisClient } from './config/redis.js'
import { setQueueManager } from './queue/context.js'
import { QueueManager } from './queue/manager.js'
import { createHashListParserWorker } from './queue/workers/hash-list-parser.js'
import { createHealthMonitorWorker } from './queue/workers/health-monitor.js'
import { createHeartbeatMonitorWorker } from './queue/workers/heartbeat-monitor.js'

const connection = createRedisClient('jobs-worker')

async function main() {
  await connection.connect()
  logger.info('Jobs worker connected to Redis')

  // The health-monitor worker calls getSystemHealth() →
  // getQueueManager(); without a QueueManager in the worker process the
  // redis and queues probes silently report unhealthy forever.
  // Instantiate one here so the worker has the same probe surface as
  // the API process. BullMQ's upsertJobScheduler is idempotent so the
  // duplicate scheduler upsert from the API and worker processes is
  // safe.
  //
  // Synchronous init failure (e.g. queue construction throws after
  // Redis connects) propagates to main().catch and exits the process.
  // Note that QueueManager.init() itself swallows initial Redis
  // connection failure and waits for the `ready` event; "fail-fast"
  // here covers post-connect setup errors, not Redis-down-at-startup.
  const queueManager = new QueueManager()
  // Initialize first, register second: the registry should never hold
  // a half-initialized manager. Today the two calls are synchronous
  // and non-overlapping, but the order makes the invariant explicit
  // for any future change that adds an await between them.
  await queueManager.init()
  setQueueManager(queueManager)

  const hashListWorker = createHashListParserWorker(connection)
  logger.info('Hash list parser worker started')

  const heartbeatWorker = createHeartbeatMonitorWorker(connection)
  logger.info('Heartbeat monitor worker started')

  const healthWorker = createHealthMonitorWorker(connection)
  logger.info('Health monitor worker started')

  const workers = [hashListWorker, heartbeatWorker, healthWorker]

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down job workers')
    await Promise.all(workers.map((w) => w.close()))
    await queueManager.shutdown()
    connection.disconnect()
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error({ err }, 'Jobs worker failed to start')
  process.exit(1)
})
