/**
 * Per-agent observed-rate EWMA (U6).
 *
 * Maintains `agent_benchmarks.observed_speed_hs` as an exponentially-weighted
 * moving average of the H/s values reported by live progress updates.
 *
 * The update is always atomic: a single `UPDATE ... SET observed_speed_hs = ROUND(...)`
 * expression computed inside SQL, so there is never a read-then-write race.
 * Cold-start seeding (observed_speed_hs IS NULL on first sample) is handled
 * by COALESCE inside the expression:
 *   ROUND(alpha * sample + (1 - alpha) * COALESCE(observed_speed_hs, speed_hs, sample))
 *
 * Observe-only: no task sizing or control-flow changes live here.
 */

import { sql } from 'drizzle-orm'

import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { db } from '../db/index.js'

// ─── Pure helper ────────────────────────────────────────────────────

/**
 * Compute one EWMA step.
 *
 * @param sample  - Most recent observed value (H/s).
 * @param prev    - Previous EWMA (or seed value on cold start).
 * @param alpha   - Smoothing factor in (0, 1]. Typical: 0.125.
 * @returns       Rounded integer suitable for a bigint column.
 */
export function computeEwma(sample: number, prev: number, alpha: number): number {
  return Math.round(alpha * sample + (1 - alpha) * prev)
}

// ─── Atomic DB update ────────────────────────────────────────────────

/**
 * Atomically update the EWMA of observed throughput for one (agent, mode) row.
 *
 * The entire EWMA expression runs inside SQL so the DB applies it as a
 * single statement — no read-then-write race (GOTCHAS.md §counters/rates).
 *
 * Cold-start: when `observed_speed_hs` is NULL, COALESCE seeds from
 * `speed_hs` (the registration benchmark). If that is somehow also NULL,
 * it falls back to the sample itself so the column is always left non-null
 * after the first call.
 *
 * No-op when no benchmark row exists for (agentId, hashcatMode) — the
 * UPDATE simply matches zero rows, which is safe.
 *
 * @param agentId      - Agent whose benchmark row to update.
 * @param hashcatMode  - Hashcat mode for the task that produced the sample.
 * @param sampleHs     - Observed speed in H/s from the progress report.
 */
export async function updateAgentObservedRate(
  agentId: number,
  hashcatMode: number,
  sampleHs: number
): Promise<void> {
  const alpha = env.AGENT_RATE_EWMA_ALPHA

  // Raw UPDATE so the whole EWMA expression is applied in one statement (no
  // read-then-write race). COALESCE seeds from the registration benchmark
  // (speed_hs) on cold start, falling back to the sample so the column is
  // always left non-null. ROUND -> ::bigint matches the column type.
  await db.execute(sql`
    UPDATE agent_benchmarks
    SET observed_speed_hs = ROUND(
      ${alpha}::numeric * ${sampleHs}::numeric
      + (1 - ${alpha}::numeric) * COALESCE(observed_speed_hs, speed_hs, ${sampleHs}::numeric)
    )::bigint
    WHERE agent_id = ${agentId} AND hashcat_mode = ${hashcatMode}
  `)

  logger.debug({ agentId, hashcatMode, sampleHs, alpha }, 'Updated agent observed rate EWMA')
}
