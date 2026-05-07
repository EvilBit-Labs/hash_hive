import { logger } from './config/logger.js';
import { createRedisClient } from './config/redis.js';
import { setQueueManager } from './queue/context.js';
import { QueueManager } from './queue/manager.js';
import { createHashListParserWorker } from './queue/workers/hash-list-parser.js';
import { createHealthMonitorWorker } from './queue/workers/health-monitor.js';
import { createHeartbeatMonitorWorker } from './queue/workers/heartbeat-monitor.js';

const connection = createRedisClient('jobs-worker');

async function main() {
  await connection.connect();
  logger.info('Jobs worker connected to Redis');

  // The health-monitor worker calls getSystemHealth() →
  // getQueueManager(); without a QueueManager in the worker process the
  // redis and queues probes silently report unhealthy forever.
  // Instantiate one here so the worker has the same probe surface as
  // the API process. BullMQ's upsertJobScheduler is idempotent so the
  // duplicate scheduler upsert from the API and worker processes is
  // safe.
  //
  // Init failure is treated as fail-fast: a worker without a
  // QueueManager cannot do its job, and warn-and-continue would leave
  // the process alive but silently broken until ops noticed.
  const queueManager = new QueueManager();
  setQueueManager(queueManager);
  await queueManager.init();

  const hashListWorker = createHashListParserWorker(connection);
  logger.info('Hash list parser worker started');

  const heartbeatWorker = createHeartbeatMonitorWorker(connection);
  logger.info('Heartbeat monitor worker started');

  const healthWorker = createHealthMonitorWorker(connection);
  logger.info('Health monitor worker started');

  const workers = [hashListWorker, heartbeatWorker, healthWorker];

  async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down job workers');
    await Promise.all(workers.map((w) => w.close()));
    await queueManager.shutdown();
    await connection.disconnect();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Jobs worker failed to start');
  process.exit(1);
});
