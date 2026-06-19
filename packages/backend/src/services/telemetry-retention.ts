/**
 * Telemetry retention policy manager (U8, KTD-7).
 *
 * Idempotently re-applies TimescaleDB retention policies for the
 * task_telemetry hypertable and its three CAGG tiers from env vars.
 * This lets operators change retention windows at runtime without a
 * migration: set the env var and restart.
 *
 * The 0022_telemetry_hypertable.sql migration installs the default
 * policies.  This function merely refreshes them on startup — a
 * harmless no-op when the env matches the migration defaults.
 *
 * MUST NOT be called from a database transaction — remove/add_retention_policy
 * modify the TimescaleDB job scheduler catalog, which is not transactional.
 * Call it outside any tx (bare db.execute), which is the pattern used here.
 */

import { sql } from 'drizzle-orm'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { db } from '../db/index.js'

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Postgres relation names for the raw hypertable and each CAGG tier. */
const TELEMETRY_RELATIONS = {
  raw: 'task_telemetry',
  m1: 'task_telemetry_1m',
  m5: 'task_telemetry_5m',
  h1: 'task_telemetry_1h',
} as const

type RelationKey = keyof typeof TELEMETRY_RELATIONS

interface TierConfig {
  relation: string
  retentionInterval: string
}

/**
 * Build the four tier configs from the current env values.
 * Each config names the relation and the retention interval literal.
 */
function buildTierConfigs(): Record<RelationKey, TierConfig> {
  return {
    raw: { relation: TELEMETRY_RELATIONS.raw, retentionInterval: env.TELEMETRY_FULLRES_RETENTION },
    m1: { relation: TELEMETRY_RELATIONS.m1, retentionInterval: env.TELEMETRY_1M_RETENTION },
    m5: { relation: TELEMETRY_RELATIONS.m5, retentionInterval: env.TELEMETRY_5M_RETENTION },
    h1: { relation: TELEMETRY_RELATIONS.h1, retentionInterval: env.TELEMETRY_1H_RETENTION },
  }
}

/**
 * Re-apply the retention policy for one relation.
 *
 * Strategy: remove the existing policy first (if_exists => true so it is
 * safe when there is no policy yet), then add the env-configured one.
 * This is simpler and more reliable than trying to update in place — the
 * alter_job() API requires knowing the job_id, which would need a lookup.
 */
async function applyRetentionForRelation(relation: string, intervalLiteral: string): Promise<void> {
  // Remove any existing retention policy (no-op if absent).
  await db.execute(sql.raw(`SELECT remove_retention_policy('${relation}', if_exists => true)`))
  // Re-add with the env-configured window.
  await db.execute(
    sql.raw(
      `SELECT add_retention_policy('${relation}', drop_after => '${intervalLiteral}'::interval, if_not_exists => true)`
    )
  )
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Idempotently re-apply retention policies for all four telemetry tiers
 * from the current env configuration.
 *
 * Safe to call multiple times: remove_retention_policy uses if_exists and
 * add_retention_policy uses if_not_exists, so repeated calls are harmless.
 *
 * Throws on DB errors — callers should catch and handle (the index.ts
 * startup call swallows errors non-fatally so a policy failure does not
 * prevent the API from serving requests).
 */
export async function applyTelemetryRetentionPolicies(): Promise<void> {
  const tiers = buildTierConfigs()

  for (const [key, { relation, retentionInterval }] of Object.entries(tiers)) {
    await applyRetentionForRelation(relation, retentionInterval)
    logger.debug({ tier: key, relation, retentionInterval }, 'telemetry retention policy applied')
  }

  logger.info(
    {
      fullres: env.TELEMETRY_FULLRES_RETENTION,
      m1: env.TELEMETRY_1M_RETENTION,
      m5: env.TELEMETRY_5M_RETENTION,
      h1: env.TELEMETRY_1H_RETENTION,
    },
    'telemetry retention policies configured'
  )
}
