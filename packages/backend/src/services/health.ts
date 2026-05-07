/**
 * System health monitoring service.
 *
 * Centralizes probe orchestration, threshold logic, and the SystemHealth
 * shape used by all three health-reporting surfaces:
 *
 *   - GET /health (public, unauthenticated, used by load balancers)
 *   - GET /api/v1/control/health (API-key authenticated, for automation)
 *   - GET /api/v1/dashboard/health (BetterAuth session, for the UI card)
 *
 * Probes run in parallel via Promise.race + a probe-level timeout so one
 * slow component never stalls the whole report. Each probe coerces its
 * own errors to `unhealthy` ComponentHealth — the service never throws
 * from getSystemHealth().
 */

import { sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { checkMinioHealth } from '../config/storage.js';
import { db } from '../db/index.js';
import { getQueueManager } from '../queue/context.js';

export type ComponentStatus = 'healthy' | 'degraded' | 'unhealthy';

export type ComponentName = 'database' | 'redis' | 'minio' | 'queues';

/**
 * Probe result shape without a `durationMs` field — that field is
 * attached by the `runProbe` wrapper, never by the probe author. Split
 * by status: a `degraded` or `unhealthy` result must carry a `message`
 * so consumers always have a useful error string to render.
 */
export type ProbeResult =
  | { status: 'healthy'; message?: string; detail?: Record<string, unknown> }
  | { status: 'degraded' | 'unhealthy'; message: string; detail?: Record<string, unknown> };

/**
 * Full ComponentHealth — ProbeResult plus the durationMs measurement
 * runProbe attaches. Discriminated by status so callers rendering
 * non-healthy components get `message` typed as required.
 */
export type ComponentHealth = ProbeResult & { durationMs: number };

export interface SystemHealth {
  status: ComponentStatus;
  timestamp: string;
  version: string;
  components: Record<ComponentName, ComponentHealth>;
}

export const HEALTH_VERSION = '1.0.0';

// Threshold semantics for the entire module: warn comparisons use `>=`
// (inclusive boundary). "Warn at 10000" means 10000 is already the warn
// state. "Warn at 80%" fires when pool reaches 80%.

/**
 * Aggregates per-component statuses using a worst-of rule:
 * unhealthy > degraded > healthy.
 */
export function aggregateStatus(
  components: Record<ComponentName, ComponentHealth>
): ComponentStatus {
  const statuses = Object.values(components).map((c) => c.status);
  if (statuses.includes('unhealthy')) return 'unhealthy';
  if (statuses.includes('degraded')) return 'degraded';
  return 'healthy';
}

/**
 * Runs a probe with a timeout. The probe returns a ComponentHealth-shaped
 * value (without durationMs); this wrapper attaches durationMs and coerces
 * thrown errors and timeouts into `unhealthy` ComponentHealth.
 */
export async function runProbe(
  name: ComponentName,
  probeFn: () => Promise<ProbeResult>,
  timeoutMs: number
): Promise<ComponentHealth> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race<ProbeResult>([
      probeFn(),
      new Promise<ProbeResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), timeoutMs);
      }),
    ]);
    return { ...result, durationMs: Date.now() - startedAt };
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === 'PROBE_TIMEOUT';
    // Distinguish operator-actionable infra failures (network, auth,
    // bucket missing) from programming errors. The latter still get
    // coerced to `unhealthy` so the report contract holds, but they
    // should land in the `error` log channel so alerting fires — a
    // TypeError surfacing as "database unhealthy" is a debugging trap.
    const isProgrammingError =
      err instanceof TypeError ||
      err instanceof ReferenceError ||
      err instanceof SyntaxError ||
      err instanceof RangeError ||
      err instanceof URIError;
    if (isProgrammingError) {
      logger.error(
        { err, probe: name },
        'health probe threw a programming error — likely a bug, not infra'
      );
    } else if (!isTimeout) {
      logger.warn({ err, probe: name }, 'health probe failed');
    }
    // Programming errors carry stack-revealing messages (e.g.
    // "Cannot read properties of undefined (reading 'foo')") that
    // would leak through to authenticated SystemHealth consumers.
    // The full err is in the structured log line; clients see a
    // generic message so probe-internal state is never on the wire.
    const message = isTimeout
      ? `probe timed out after ${timeoutMs}ms`
      : isProgrammingError
        ? 'probe failed: internal error'
        : err instanceof Error
          ? err.message
          : 'probe failed';
    return {
      status: 'unhealthy',
      message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Probe Implementations ──────────────────────────────────────────

export interface DatabaseProbeDeps {
  ping: () => Promise<unknown>;
  poolStats: () => Promise<{ used: number; max: number }>;
}

export async function probeDatabase(
  deps: DatabaseProbeDeps,
  warnPct: number
): Promise<ProbeResult> {
  await deps.ping();
  const { used, max } = await deps.poolStats();
  const pct = max > 0 ? (used / max) * 100 : 0;
  const detail = { connectionsUsed: used, connectionsMax: max, connectionsPct: Math.round(pct) };
  if (pct >= warnPct) {
    return {
      status: 'degraded',
      message: `database connection pool ${Math.round(pct)}% full (${used}/${max}) at or above warn threshold ${warnPct}%`,
      detail,
    };
  }
  return { status: 'healthy', detail };
}

export interface RedisProbeDeps {
  /** Returns 'connected' iff the Redis client is in the ready state. */
  status: () => 'connected' | 'disconnected';
}

export async function probeRedis(deps: RedisProbeDeps): Promise<ProbeResult> {
  if (deps.status() !== 'connected') {
    return { status: 'unhealthy', message: 'redis connection not ready' };
  }
  return { status: 'healthy' };
}

export interface MinioProbeDeps {
  check: () => Promise<{ status: 'connected' | 'disconnected'; bucket: string }>;
}

export async function probeMinio(deps: MinioProbeDeps): Promise<ProbeResult> {
  const result = await deps.check();
  if (result.status !== 'connected') {
    return {
      status: 'unhealthy',
      message: `minio bucket ${result.bucket} unreachable`,
      detail: { bucket: result.bucket },
    };
  }
  return { status: 'healthy', detail: { bucket: result.bucket } };
}

export interface QueueStat {
  waiting: number;
  active: number;
  failed: number;
}

export interface QueuesProbeDeps {
  health: () => Promise<{
    status: 'connected' | 'disconnected';
    queues: Record<string, QueueStat>;
  }>;
}

export async function probeQueues(
  deps: QueuesProbeDeps,
  warnDepth: number,
  warnFailed: number
): Promise<ProbeResult> {
  const result = await deps.health();
  if (result.status !== 'connected') {
    return {
      status: 'unhealthy',
      message: 'queue manager not connected to redis',
      detail: { queues: {} },
    };
  }

  const offenders: string[] = [];
  for (const [name, stats] of Object.entries(result.queues)) {
    if (stats.waiting >= warnDepth) {
      offenders.push(`${name} waiting=${stats.waiting} >= ${warnDepth}`);
    }
    if (stats.failed >= warnFailed) {
      offenders.push(`${name} failed=${stats.failed} >= ${warnFailed}`);
    }
  }

  if (offenders.length > 0) {
    return {
      status: 'degraded',
      message: `queue thresholds exceeded: ${offenders.join('; ')}`,
      detail: { queues: result.queues, offenders },
    };
  }

  return { status: 'healthy', detail: { queues: result.queues } };
}

// ─── Default Production Wiring ──────────────────────────────────────

// pg_settings.max_connections only changes on Postgres restart, so it's
// safe to cache for the lifetime of the process. Caching it eliminates
// one of the three sequential round-trips probeDatabase otherwise pays
// per tick.
let cachedMaxConnections: number | null = null;

async function defaultDatabasePoolStats(): Promise<{ used: number; max: number }> {
  const usedRows = (await db.execute(
    sql`SELECT count(*)::int AS used FROM pg_stat_activity WHERE datname = current_database()`
  )) as unknown as Array<{ used: number }>;

  let max = cachedMaxConnections;
  if (max === null) {
    const maxRows = (await db.execute(
      sql`SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'`
    )) as unknown as Array<{ max: number }>;
    const candidate = maxRows[0]?.max;
    // Validate before caching: a Postgres misconfiguration or a future
    // schema-change in pg_settings could return 0/NaN/non-integer; we'd
    // poison the cache for the lifetime of the process.
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      cachedMaxConnections = candidate;
      max = candidate;
    } else {
      logger.warn({ candidate }, 'pg_settings returned unexpected max_connections; not caching');
      max = 1;
    }
  }
  const used = usedRows[0]?.used ?? 0;
  return { used, max };
}

/** Test-only: clears the max_connections cache (e.g. between Postgres versions). */
export function __resetMaxConnectionsCache(): void {
  cachedMaxConnections = null;
}

function buildDefaultProbes(): {
  database: DatabaseProbeDeps;
  redis: RedisProbeDeps;
  minio: MinioProbeDeps;
  queues: QueuesProbeDeps;
} {
  const qm = getQueueManager();
  return {
    database: {
      ping: () => db.execute(sql`SELECT 1`),
      poolStats: defaultDatabasePoolStats,
    },
    redis: {
      // Cheap status check via QueueManager's connection — no queue
      // iteration. Avoids doubling Redis round-trips per health request,
      // which would happen if redis and queues probes both called
      // qm.getHealth().
      status: () => qm?.getRedisStatus() ?? 'disconnected',
    },
    minio: { check: checkMinioHealth },
    queues: {
      health: async () => {
        if (!qm) {
          return { status: 'disconnected', queues: {} };
        }
        return qm.getHealth();
      },
    },
  };
}

// ─── Public Entry Point ─────────────────────────────────────────────

export interface SystemHealthOptions {
  /** Override probes for testing. */
  probes?: {
    database?: DatabaseProbeDeps;
    redis?: RedisProbeDeps;
    minio?: MinioProbeDeps;
    queues?: QueuesProbeDeps;
  };
  /** Override thresholds for testing. */
  thresholds?: {
    probeTimeoutMs?: number;
    queueWarnDepth?: number;
    queueWarnFailed?: number;
    dbConnectionWarnPct?: number;
  };
}

async function executeProbes(opts: SystemHealthOptions): Promise<SystemHealth> {
  const defaults = buildDefaultProbes();
  const probes = {
    database: opts.probes?.database ?? defaults.database,
    redis: opts.probes?.redis ?? defaults.redis,
    minio: opts.probes?.minio ?? defaults.minio,
    queues: opts.probes?.queues ?? defaults.queues,
  };
  const thresholds = {
    probeTimeoutMs: opts.thresholds?.probeTimeoutMs ?? env.HEALTH_PROBE_TIMEOUT_MS,
    queueWarnDepth: opts.thresholds?.queueWarnDepth ?? env.HEALTH_QUEUE_WARN_DEPTH,
    queueWarnFailed: opts.thresholds?.queueWarnFailed ?? env.HEALTH_QUEUE_WARN_FAILED,
    dbConnectionWarnPct: opts.thresholds?.dbConnectionWarnPct ?? env.HEALTH_DB_CONNECTION_WARN_PCT,
  };

  const [database, redis, minio, queues] = await Promise.all([
    runProbe(
      'database',
      () => probeDatabase(probes.database, thresholds.dbConnectionWarnPct),
      thresholds.probeTimeoutMs
    ),
    runProbe('redis', () => probeRedis(probes.redis), thresholds.probeTimeoutMs),
    runProbe('minio', () => probeMinio(probes.minio), thresholds.probeTimeoutMs),
    runProbe(
      'queues',
      () => probeQueues(probes.queues, thresholds.queueWarnDepth, thresholds.queueWarnFailed),
      thresholds.probeTimeoutMs
    ),
  ]);

  const components: Record<ComponentName, ComponentHealth> = { database, redis, minio, queues };
  return {
    status: aggregateStatus(components),
    timestamp: new Date().toISOString(),
    version: HEALTH_VERSION,
    components,
  };
}

// ─── Caching layer ──────────────────────────────────────────────────
//
// Each call fans out probes that hit Postgres (3 queries), Redis (status
// + per-queue counts × 7 queues = ~21 calls), MinIO (HeadBucket), and
// usually completes in tens of ms. Without caching, three surfaces
// (/health, /api/v1/control/health, /api/v1/dashboard/health) plus the
// 30s scheduled monitor plus a polling dashboard could pile probes
// against a degraded backend exactly when latency is already high.
//
// The cache and in-flight dedup are bypassed when the caller passes
// `opts.probes` or `opts.thresholds` (i.e. tests using injected probes)
// so unit tests remain deterministic and isolated.

const HEALTH_CACHE_TTL_MS = 5_000;
let cachedHealth: { value: SystemHealth; expiresAt: number } | null = null;
let inFlightHealth: Promise<SystemHealth> | null = null;

/** Test-only: clears the module-level cache. */
export function __resetSystemHealthCache(): void {
  cachedHealth = null;
  inFlightHealth = null;
}

export async function getSystemHealth(opts: SystemHealthOptions = {}): Promise<SystemHealth> {
  // Bypass cache when tests inject custom probes or thresholds — those
  // calls are deterministic and must not see stale state from prior
  // tests or production calls.
  if (opts.probes || opts.thresholds) {
    return executeProbes(opts);
  }

  const now = Date.now();
  if (cachedHealth && cachedHealth.expiresAt > now) {
    return cachedHealth.value;
  }

  // In-flight dedup: concurrent callers under load share one execution.
  if (inFlightHealth) {
    return inFlightHealth;
  }

  inFlightHealth = executeProbes(opts)
    .then((value) => {
      cachedHealth = { value, expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      inFlightHealth = null;
    });

  return inFlightHealth;
}

/**
 * Translates SystemHealth into the legacy public /health envelope shape.
 *
 * Backward-compat surface preserved for load balancers and anonymous
 * probes that consumed the pre-#109 endpoint:
 * - `status: 'ok' | 'degraded'` — coarse two-tier signal kept for older
 *   monitors. The HTTP status code (503 on unhealthy) is the additional
 *   signal those monitors can opt into.
 * - `services.{database,redis,minio,queues}.status: 'connected' |
 *   'disconnected'` — coarse connectivity. A "degraded" component
 *   (queue depth above warn threshold, DB pool >= warn percent) is still
 *   `connected` since it's reachable; only `unhealthy` collapses to
 *   `disconnected`.
 * - `services.minio.bucket` — preserved.
 * - `services.queues.queues` — a flat `{ queueName: { waiting, active,
 *   failed } }` map matching what `qm.getHealth()` previously returned
 *   in the inline /health handler. Preserved so anonymous probes that
 *   already iterated this map keep working.
 *
 * New additive field:
 * - `aggregateStatus: 'healthy' | 'degraded' | 'unhealthy'` — the full
 *   three-tier signal, exposed in the body so JSON-only monitors can
 *   distinguish degraded from unhealthy without inspecting the HTTP
 *   status.
 *
 * Anti-leak guarantee: per-component `detail` and `message` are omitted
 * so probe error messages, DB connection counts, and queue offender
 * details never reach anonymous callers. The only structured data that
 * survives is queue counts — already part of the pre-#109 contract.
 */
/**
 * Anti-leak guard fields on every legacy-envelope service entry: a
 * future PR adding `message` or `detail` here would silently leak
 * probe internals to anonymous callers, so we make it a compile error
 * instead. New per-service fields (like `bucket` on minio or `queues`
 * on queues) are added by intersection on the specific entry below.
 */
type LegacyServiceGuards = {
  message?: never;
  detail?: never;
};

export interface LegacyHealthEnvelope {
  status: 'ok' | 'degraded';
  /** Three-tier aggregate: healthy | degraded | unhealthy. */
  aggregateStatus: ComponentStatus;
  timestamp: string;
  version: string;
  services: {
    database: LegacyServiceGuards & { status: 'connected' | 'disconnected' };
    redis: LegacyServiceGuards & { status: 'connected' | 'disconnected' };
    minio: LegacyServiceGuards & {
      status: 'connected' | 'disconnected';
      bucket?: string;
    };
    queues: LegacyServiceGuards & {
      status: 'connected' | 'disconnected';
      queues: Record<string, { waiting: number; active: number; failed: number }>;
    };
  };
}

function legacyServiceStatus(s: ComponentStatus): 'connected' | 'disconnected' {
  return s === 'unhealthy' ? 'disconnected' : 'connected';
}

function extractQueueStats(
  detail: Record<string, unknown> | undefined
): Record<string, { waiting: number; active: number; failed: number }> {
  const raw = detail?.['queues'];
  if (!raw || typeof raw !== 'object') return {};
  return raw as Record<string, { waiting: number; active: number; failed: number }>;
}

export function legacyPublicEnvelope(health: SystemHealth): LegacyHealthEnvelope {
  const minioBucket =
    (health.components.minio.detail?.['bucket'] as string | undefined) ?? undefined;
  return {
    status: health.status === 'healthy' ? 'ok' : 'degraded',
    aggregateStatus: health.status,
    timestamp: health.timestamp,
    version: health.version,
    services: {
      database: { status: legacyServiceStatus(health.components.database.status) },
      redis: { status: legacyServiceStatus(health.components.redis.status) },
      minio: {
        status: legacyServiceStatus(health.components.minio.status),
        ...(minioBucket ? { bucket: minioBucket } : {}),
      },
      queues: {
        status: legacyServiceStatus(health.components.queues.status),
        queues: extractQueueStats(health.components.queues.detail),
      },
    },
  };
}
