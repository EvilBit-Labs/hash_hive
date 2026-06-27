import { z } from 'zod'

// A simple Postgres interval literal: "<n> <unit>" (e.g. "30 days", "2 hours").
// Used to validate telemetry retention windows that are interpolated into raw
// SQL, so a malformed value is rejected at startup rather than swallowed later.
const INTERVAL_LITERAL = /^\d+\s+(second|minute|hour|day|week|month|year)s?$/i

export const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // PostgreSQL
  DATABASE_URL: z.url(),
  // Connection pool sizing. Default 50 covers request handlers,
  // BullMQ workers (which currently share this pool), and the
  // health/heartbeat sweeps. Pre-#159 baseline of 20 saturated under
  // ~50 concurrent dashboard users + hash-list parser streaming.
  // Operators with heavier loads can bump via env.
  DATABASE_POOL_MAX: z.coerce.number().int().min(5).max(500).default(50),
  // Idle connections returned to the pool after this many seconds.
  // postgres.js default is 0 (no idle), but a non-zero idle keeps
  // warm connections around for burst traffic.
  DATABASE_IDLE_TIMEOUT: z.coerce.number().int().min(0).default(30),

  // Redis
  REDIS_URL: z.url(),

  // Object storage (SeaweedFS in dev / air-gapped prod, AWS S3 in hosted envs)
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  // Trim before applying min so a whitespace-only env var fails env
  // parsing (fail-fast) rather than silently becoming the bucket name.
  // Note: `.default()` only fires when `S3_BUCKET` is undefined; a
  // whitespace-only value reaches the transform, trims to `""`, and is
  // rejected by `.min(1)` — `loadEnv()` throws before startup.
  S3_BUCKET: z
    .string()
    .transform((v) => v.trim())
    .pipe(z.string().min(1))
    .default('hashhive'),
  S3_REGION: z.string().default('us-east-1'),

  // BetterAuth (generate with: openssl rand -base64 32)
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url().optional(),
  // Comma-separated extra origins to add to BetterAuth's trustedOrigins
  // beyond the dev defaults. Used by the Playwright E2E suite to allow
  // the test frontend (localhost:3400) without weakening the production
  // empty-list policy.
  BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),

  // System health monitoring (issue #109)
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  HEALTH_QUEUE_WARN_DEPTH: z.coerce.number().int().nonnegative().default(10_000),
  HEALTH_QUEUE_WARN_FAILED: z.coerce.number().int().nonnegative().default(100),
  HEALTH_DB_CONNECTION_WARN_PCT: z.coerce.number().min(0).max(100).default(80),
  HEALTH_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // Per-agent EWMA smoothing factor for observed_speed_hs (U6).
  // Lower values smooth more aggressively; higher values track recent samples
  // faster. The default 0.125 (1/8) is a conventional starting point.
  AGENT_RATE_EWMA_ALPHA: z.coerce.number().min(0).max(1).default(0.125),

  // Telemetry RRD retention windows (U8, KTD-7).
  // Postgres interval literals — e.g. "2 hours", "7 days".
  // applyTelemetryRetentionPolicies() re-applies these at startup so operators
  // can change the windows without a migration. Defaults match the 0022
  // migration, which sets the initial policies; a no-op re-apply is harmless.
  //
  // The values are interpolated into a raw `add_retention_policy(... ::interval)`
  // statement (telemetry-retention.ts), so constrain them to a simple
  // "<n> <unit>" interval shape: a misconfiguration fails loudly at startup here
  // rather than as a swallowed SQL error later, and the regex closes the raw-SQL
  // interpolation vector even though the source is operator-controlled env.
  TELEMETRY_FULLRES_RETENTION: z.string().regex(INTERVAL_LITERAL).default('1 hour'),
  TELEMETRY_1M_RETENTION: z.string().regex(INTERVAL_LITERAL).default('24 hours'),
  TELEMETRY_5M_RETENTION: z.string().regex(INTERVAL_LITERAL).default('7 days'),
  TELEMETRY_1H_RETENTION: z.string().regex(INTERVAL_LITERAL).default('30 days'),

  // Task lease duration in milliseconds (U11, KTD-5).
  // The claim CTE sets lease_expires_at = NOW() + this interval so a
  // task is reclaimed by the next claimant if the lessee stops reporting.
  // 90 s is comfortably above the ~3 s agent report cadence; operators
  // can lower it for tighter reclaim windows or raise it for slow tasks.
  TASK_LEASE_DURATION_MS: z.coerce.number().int().positive().default(90_000),
  // Target wall-clock duration for a claimed parcel (U13 split-on-claim). At
  // claim, an oversized range is trimmed to ~this many seconds of work at the
  // agent's observed-speed EWMA; the remainder is re-pended. Default 300 s
  // (>= ~20x hashcat startup cost so per-task overhead stays amortized).
  TASK_TARGET_DURATION_SECONDS: z.coerce.number().int().positive().default(300),

  // Audit log retention window (U9, KTD-5).
  // Postgres interval literal — e.g. "365 days", "90 days".
  // The audit-retention worker runs a batched DELETE each day and purges
  // audit_logs rows (including orphaned NULL-project_id rows) older than this
  // window. A misconfiguration fails loudly here at startup rather than as a
  // swallowed SQL error later, and the regex closes the bind-parameter
  // interpolation vector even though the source is operator-controlled env.
  AUDIT_LOG_RETENTION: z.string().regex(INTERVAL_LITERAL).default('365 days'),

  // Raw-flags denylist override (#104). The agent advanced-config raw-flags
  // escape hatch rejects any hashcat flag in this list. It is a FOOTGUN GUARD,
  // not a security boundary (the model trusts agents): the default blocks the
  // flags the agent relies on to drive/monitor a job — result capture,
  // --status-json telemetry, session/restore — so an operator cannot silently
  // break a rig. Comma- or whitespace-separated. When SET it REPLACES the
  // built-in default (RAW_FLAG_DENYLIST in @hashhive/shared); when UNSET the
  // default applies; set it to an empty string to disable the guard entirely
  // (the operator then owns the risk). undefined -> use default; [] -> no guard.
  RAW_FLAG_DENYLIST: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(/[\s,]+/).filter(Boolean))),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const formatted = result.error.flatten().fieldErrors
    const missing = Object.entries(formatted)
      .map(([key, errors]) => `  ${key}: ${errors?.join(', ')}`)
      .join('\n')

    throw new Error(`Invalid environment variables:\n${missing}`)
  }

  return result.data
}

export const env = loadEnv()

/**
 * Warn-once at startup when the operator did not set `S3_BUCKET` and the
 * Zod default kicked in. Fine for dev (`hashhive` matches the
 * docker-compose bucket-init default) but almost certainly wrong in any
 * other deployment — without this, a misconfigured prod silently probes a
 * bucket that does not exist and the dashboard shows
 * `bucket: hashhive, status: disconnected` with no hint that the bucket
 * name itself is suspect. Uses console.warn rather than the structured
 * logger to avoid an import cycle at module load.
 *
 * Only triggers when `S3_BUCKET` is genuinely unset; a whitespace-only
 * value fails env parsing in `loadEnv()` above and never reaches here.
 */
if (process.env['S3_BUCKET'] === undefined && env.NODE_ENV !== 'test') {
  // oxlint-disable-next-line no-console -- pre-logger startup warning
  console.warn(
    `[env] S3_BUCKET not set; defaulted to "${env.S3_BUCKET}". Fine for dev; set it explicitly in any other deployment.`
  )
}
