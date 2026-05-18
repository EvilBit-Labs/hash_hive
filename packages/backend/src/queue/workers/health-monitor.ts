/**
 * Scheduled health-monitor worker (issue #109).
 *
 * Runs `getSystemHealth()` every HEALTH_MONITOR_INTERVAL_MS and broadcasts
 * a `system_health` WebSocket event for each component whose status flipped
 * since the last run.
 *
 * Last-known-state is held in-memory (primary) and mirrored to Redis with
 * a 24h TTL (backup). This split matters when Redis itself is the failing
 * component: an in-memory cache survives a Redis outage so the
 * healthy → unhealthy → healthy round-trip still emits both transitions.
 * If we relied on Redis alone, a Redis-down probe would (a) fail to read
 * prior state → seen as first-tick (no broadcast), then (b) fail to write
 * "unhealthy" → cache stays stale, then (c) on recovery, current=healthy
 * == last=healthy → no recovery broadcast either. The full down/up cycle
 * would be silent.
 *
 * Redis is still mirrored so a fresh worker boot has a starting point
 * (avoids emitting a bogus "all green just transitioned" volley after a
 * restart). On boot the in-memory cache is empty; the first tick reads
 * Redis to seed it, then operates from memory thereafter.
 *
 * Logging happens every tick (so degradations are grep-able even without
 * a transition); broadcasts happen only on transition (so the WS channel
 * doesn't see noise on every poll).
 */

import { type ConnectionOptions, Worker } from 'bullmq';
import type Redis from 'ioredis';
import { logger } from '../../config/logger.js';
import { QUEUE_NAMES } from '../../config/queue.js';
import { broadcastSystemHealth } from '../../services/events.js';
import {
  type ComponentHealth,
  type ComponentName,
  type ComponentStatus,
  getSystemHealth,
} from '../../services/health.js';
import type { HealthMonitorJob } from '../types.js';
import { attachWorkerMetrics } from './metrics.js';

const COMPONENTS: ComponentName[] = ['database', 'redis', 'minio', 'queues'];
const REDIS_KEY_PREFIX = 'health:last-status:';
const REDIS_KEY_TTL_SEC = 24 * 60 * 60;

export interface HealthMonitorDeps {
  /**
   * Reads in-memory last-known-status for the component. Returns null
   * only on a fresh-boot tick before Redis is queried.
   */
  readMemoryStatus: (component: ComponentName) => ComponentStatus | null;
  /** Writes the new status to in-memory cache. */
  writeMemoryStatus: (component: ComponentName, status: ComponentStatus) => void;
  /**
   * Reads the Redis-backed status. Used only when in-memory has no prior
   * state for a component (post-boot seeding). Failure returns null, which
   * is the same as no prior state.
   */
  readRedisStatus: (component: ComponentName) => Promise<ComponentStatus | null>;
  /**
   * Best-effort write to Redis. Failure is logged but never propagates —
   * the in-memory cache is authoritative for transition detection.
   */
  writeRedisStatus: (component: ComponentName, status: ComponentStatus) => Promise<void>;
  /** Reports a component status transition to subscribed clients. */
  broadcast: (component: ComponentName, status: ComponentStatus, message?: string) => void;
  /** Produces the current SystemHealth report. */
  fetchHealth: () => Promise<{ components: Record<ComponentName, ComponentHealth> }>;
}

export interface HealthMonitorTickResult {
  /** Components whose status flipped this tick (broadcasts emitted). */
  transitioned: ComponentName[];
  /** Components seen for the first time since worker start (no broadcast). */
  initialized: ComponentName[];
  /** Components whose status was unchanged. */
  unchanged: ComponentName[];
}

/**
 * Single tick of the monitor. Pure with respect to its `deps` so tests
 * can drive it deterministically without BullMQ or Redis.
 */
export async function runHealthMonitorTick(
  deps: HealthMonitorDeps
): Promise<HealthMonitorTickResult> {
  let report: { components: Record<ComponentName, ComponentHealth> };
  try {
    report = await deps.fetchHealth();
  } catch (err) {
    // Defensive: every current probe coerces errors to unhealthy, but a
    // future probe could throw. Swallow here so a single bad tick
    // doesn't flood BullMQ's failed-jobs metric. The next tick gets a
    // fresh shot.
    logger.error({ err }, 'health monitor: getSystemHealth threw — skipping tick');
    return { transitioned: [], initialized: [], unchanged: [] };
  }

  const result: HealthMonitorTickResult = { transitioned: [], initialized: [], unchanged: [] };

  for (const component of COMPONENTS) {
    const current = report.components[component];

    // In-memory is authoritative for transition detection. Only fall
    // through to Redis on a cache miss (post-boot first tick for this
    // component) so the worker survives Redis outages without losing
    // transition signal — see the module docstring for the failure
    // mode this is guarding against.
    let last: ComponentStatus | null = deps.readMemoryStatus(component);
    if (last === null) {
      try {
        last = await deps.readRedisStatus(component);
      } catch (err) {
        logger.warn({ err, component }, 'health monitor: failed to seed status from Redis');
      }
    }

    if (last === null) {
      result.initialized.push(component);
    } else if (last !== current.status) {
      result.transitioned.push(component);
      try {
        deps.broadcast(component, current.status, current.message);
      } catch (err) {
        logger.error({ err, component }, 'health monitor: broadcast failed');
      }
    } else {
      result.unchanged.push(component);
    }

    // Update in-memory first (always succeeds; authoritative).
    deps.writeMemoryStatus(component, current.status);
    // Best-effort Redis mirror so the next worker boot has prior state.
    try {
      await deps.writeRedisStatus(component, current.status);
    } catch (err) {
      logger.warn({ err, component }, 'health monitor: failed to mirror status to Redis');
    }
  }

  // Always log a structured summary so degraded states are grep-able
  // even without a transition.
  const componentSummary = Object.fromEntries(
    Object.entries(report.components).map(([k, v]) => [k, v.status])
  );
  logger.info(
    {
      transitioned: result.transitioned,
      initialized: result.initialized,
      components: componentSummary,
    },
    'health monitor tick'
  );

  return result;
}

/**
 * Builds production deps: in-memory cache + Redis backup + WS broadcast.
 * The memoryCache is captured in the closure so each worker invocation
 * shares the same cache across ticks.
 */
function buildProductionDeps(connection: Redis): HealthMonitorDeps {
  const memoryCache = new Map<ComponentName, ComponentStatus>();
  return {
    readMemoryStatus: (component) => memoryCache.get(component) ?? null,
    writeMemoryStatus: (component, status) => {
      memoryCache.set(component, status);
    },
    readRedisStatus: async (component) => {
      const value = await connection.get(`${REDIS_KEY_PREFIX}${component}`);
      if (value === 'healthy' || value === 'degraded' || value === 'unhealthy') {
        return value;
      }
      return null;
    },
    writeRedisStatus: async (component, status) => {
      await connection.set(`${REDIS_KEY_PREFIX}${component}`, status, 'EX', REDIS_KEY_TTL_SEC);
    },
    broadcast: (component, status, message) => {
      broadcastSystemHealth(component, status, message);
    },
    fetchHealth: () => getSystemHealth(),
  };
}

export function createHealthMonitorWorker(connection: Redis): Worker<HealthMonitorJob> {
  const deps = buildProductionDeps(connection);

  const worker = new Worker<HealthMonitorJob>(
    QUEUE_NAMES.HEALTH_MONITOR,
    async (job) => {
      logger.debug({ jobId: job.id, triggeredAt: job.data.triggeredAt }, 'health monitor job');
      return runHealthMonitorTick(deps);
    },
    // Cast needed: our ioredis version may differ from BullMQ's bundled ioredis types
    { connection: connection as unknown as ConnectionOptions }
  );

  attachWorkerMetrics(worker, {
    queueName: QUEUE_NAMES.HEALTH_MONITOR,
    failureMessage: 'health monitor job failed',
  });

  return worker;
}
