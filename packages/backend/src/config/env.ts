import { z } from 'zod'

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // PostgreSQL
  DATABASE_URL: z.string().url(),

  // Redis
  REDIS_URL: z.string().url(),

  // Object storage (SeaweedFS in dev / air-gapped prod, AWS S3 in hosted envs)
  S3_ENDPOINT: z.string().url(),
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
  BETTER_AUTH_URL: z.string().url().optional(),

  // System health monitoring (issue #109)
  HEALTH_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  HEALTH_QUEUE_WARN_DEPTH: z.coerce.number().int().nonnegative().default(10_000),
  HEALTH_QUEUE_WARN_FAILED: z.coerce.number().int().nonnegative().default(100),
  HEALTH_DB_CONNECTION_WARN_PCT: z.coerce.number().min(0).max(100).default(80),
  HEALTH_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
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
