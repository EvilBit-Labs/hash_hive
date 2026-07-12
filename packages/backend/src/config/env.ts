import { z } from 'zod'

// A simple Postgres interval literal: "<n> <unit>" (e.g. "30 days", "2 hours").
// Used to validate telemetry retention windows that are interpolated into raw
// SQL, so a malformed value is rejected at startup rather than swallowed later.
const INTERVAL_LITERAL = /^\d+\s+(second|minute|hour|day|week|month|year)s?$/i

export const envSchema = z
  .object({
    PORT: z.coerce.number().default(4000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
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

    // Blob-reclamation retention window (issue #106 U11).
    // Postgres interval literal — e.g. "90 days", "30 days".
    // The blob-reclamation worker runs a daily bounded sweep and purges the
    // object-store blob (not the row) of word/rule/mask list resources archived
    // longer than this window, provided no active (non-archived) attack still
    // references them. A misconfiguration fails loudly here at startup rather
    // than as a swallowed SQL error later, and the regex closes the bind-
    // parameter interpolation vector even though the source is operator-
    // controlled env.
    BLOB_RECLAMATION_RETENTION: z.string().regex(INTERVAL_LITERAL).default('90 days'),

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

    // Directory (AD/LDAP) authentication (#124, U1). Disabled by default so
    // existing deployments are unaffected. When LDAP_ENABLED is true, the
    // superRefine below requires the fields the directory client (U2) and
    // provisioning service (U4) cannot function without, so a misconfigured
    // deployment fails at startup rather than surfacing as a runtime 500 on
    // the first directory sign-in attempt.
    LDAP_ENABLED: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    // ldap:// or ldaps:// connection string. Not validated as a strict URL
    // here (some ldapts-accepted forms don't round-trip through the WHATWG
    // URL parser); required when LDAP_ENABLED (see superRefine).
    LDAP_URL: z.string().optional(),
    // Transport mode. 'none' (plaintext) requires the explicit
    // LDAP_ALLOW_INSECURE_TRANSPORT opt-in below — plaintext LDAP exposes the
    // bind password and every directory user's password on the wire.
    LDAP_TLS: z.enum(['ldaps', 'starttls', 'none']).default('ldaps'),
    // Optional PEM-encoded CA certificate (or filesystem path to one) so a
    // self-signed lab certificate validates instead of requiring
    // NODE_TLS_REJECT_UNAUTHORIZED=0.
    LDAP_TLS_CA_CERT: z.string().optional(),
    // Second opt-in required when LDAP_TLS=none (see superRefine). Kept
    // separate from LDAP_TLS itself so choosing "none" is not, by itself,
    // sufficient to run insecure — an operator must deliberately set this too.
    LDAP_ALLOW_INSECURE_TRANSPORT: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    // Read-only service-account bind identity used for search-then-bind (R2).
    LDAP_BIND_DN: z.string().optional(),
    LDAP_BIND_PASSWORD: z.string().optional(),
    // Base DN to search for the user entry, and the filter template applied
    // against the submitted username (e.g. "(uid=%s)" or
    // "(sAMAccountName=%s)"). Exact templating token/escaping is finalized in
    // U2 against the ldapts filter APIs.
    LDAP_SEARCH_BASE: z.string().optional(),
    LDAP_USER_FILTER: z.string().optional(),
    // Group-membership lookup strategy: 'memberOf' reads the attribute off
    // the user entry (typical AD); 'search' queries the group base for
    // entries whose member list includes the user DN (typical OpenLDAP).
    LDAP_GROUP_STRATEGY: z.enum(['memberOf', 'search']).default('memberOf'),
    // Required only when LDAP_GROUP_STRATEGY is 'search' (see superRefine).
    LDAP_GROUP_BASE: z.string().optional(),
    // Group-to-role map as three discrete comma-separated lists (KTD4) rather
    // than one parsed blob — each entry is a group DN or CN depending on
    // LDAP_GROUP_STRATEGY. Default '' (no groups mapped) so an operator who
    // enables LDAP_ENABLED but forgets a role's groups fails closed for that
    // role (nobody matches an empty list) rather than the schema rejecting
    // startup — config/ldap.ts's buildGroupRoleMap parses these into a
    // { admin, operator, analyst } list map.
    LDAP_GROUP_ADMIN: z.string().default(''),
    LDAP_GROUP_OPERATOR: z.string().default(''),
    LDAP_GROUP_ANALYST: z.string().default(''),
    // The single directory attribute read as the user's email (R10). U3
    // reads `attributes[config.emailAttribute]` with a synthesized
    // `username@LDAP_REALM` fallback when the attribute is absent — this is
    // intentionally one configurable attribute name, not a hardcoded
    // mail/userPrincipalName pair, so an AD deployment can point it at
    // userPrincipalName instead without a code change.
    LDAP_EMAIL_ATTRIBUTE: z.string().default('mail'),
    // Domain suffix used to synthesize an email (`username@LDAP_REALM`) when
    // the directory exposes no email attribute (R10, AE5). Required when
    // LDAP_ENABLED (see superRefine).
    LDAP_REALM: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.LDAP_ENABLED) {
      return
    }

    const requireField = (
      key:
        | 'LDAP_URL'
        | 'LDAP_BIND_DN'
        | 'LDAP_BIND_PASSWORD'
        | 'LDAP_SEARCH_BASE'
        | 'LDAP_USER_FILTER'
        | 'LDAP_REALM'
        | 'LDAP_GROUP_BASE',
      message: string
    ) => {
      const value = data[key]
      if (typeof value !== 'string' || value.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [key] })
      }
    }

    requireField('LDAP_URL', 'LDAP_URL is required when LDAP_ENABLED is true')
    requireField('LDAP_BIND_DN', 'LDAP_BIND_DN is required when LDAP_ENABLED is true')
    requireField('LDAP_BIND_PASSWORD', 'LDAP_BIND_PASSWORD is required when LDAP_ENABLED is true')
    requireField('LDAP_SEARCH_BASE', 'LDAP_SEARCH_BASE is required when LDAP_ENABLED is true')
    requireField('LDAP_USER_FILTER', 'LDAP_USER_FILTER is required when LDAP_ENABLED is true')
    requireField(
      'LDAP_REALM',
      'LDAP_REALM is required when LDAP_ENABLED is true (used to synthesize an email when the directory has no email attribute for a user)'
    )

    if (data.LDAP_GROUP_STRATEGY === 'search') {
      requireField(
        'LDAP_GROUP_BASE',
        'LDAP_GROUP_BASE is required when LDAP_GROUP_STRATEGY is "search"'
      )
    }

    if (data.LDAP_TLS === 'none' && !data.LDAP_ALLOW_INSECURE_TRANSPORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'LDAP_TLS is "none" but LDAP_ALLOW_INSECURE_TRANSPORT is not "true" -- plaintext LDAP exposes the bind password and every user password on the wire. Set LDAP_ALLOW_INSECURE_TRANSPORT=true to explicitly accept this risk (lab-only).',
        path: ['LDAP_ALLOW_INSECURE_TRANSPORT'],
      })
    }
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
