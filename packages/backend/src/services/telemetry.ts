/**
 * Task telemetry service (U4).
 *
 * Provides `appendTaskTelemetry` — an insert helper that writes one row
 * to the append-only `task_telemetry` table per progress report.  The
 * table is plain Postgres in Phase 2 and becomes a TimescaleDB hypertable
 * in U8 (create_hypertable with migrate_data).  No PRIMARY KEY and no
 * UNIQUE constraint may be added here; TimescaleDB rejects any constraint
 * that excludes the partition column `time`.
 *
 * This module is intentionally small: it owns only the insert helper.
 * All reads (aggregates, EWMA) belong in dedicated query modules added in
 * later units.
 */

import type { InsertTaskTelemetry } from '@hashhive/shared'

import { taskTelemetry } from '@hashhive/shared'

import { db } from '../db/index.js'

/** Drizzle transaction handle — the callback argument type of `db.transaction`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Coerce a keyspace-progress value from the agent progress report to a
 * bigint, accepting ONLY a non-negative safe-integer JS number OR a
 * digit-only string.  Everything else (negatives, decimals, unsafe-large
 * floats, non-numeric strings, null) coerces to 0n so a malformed report
 * cannot corrupt the bigint column.
 *
 * Mirrors `readNonNegativeBigint` in `services/tasks/_internals.ts` but
 * is kept private here so callers do not reach into this module for a
 * general-purpose utility.
 */
function coerceToBigint(raw: unknown): bigint {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return BigInt(raw)
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw)
  return 0n
}

/**
 * Insert one telemetry row for a progress report.
 *
 * The insert is intentionally fire-and-forget from the caller's
 * perspective (the caller wraps it in a transaction alongside the hot-row
 * UPDATE); this function does no retry logic and lets any DB error
 * propagate so the transaction can roll both writes back atomically.
 *
 * @param tx - A drizzle transaction object (or the default `db` client).
 *             Callers MUST pass the transaction handle so both the hot-row
 *             UPDATE and this insert share the same transaction boundary.
 * @param row - The telemetry fields to persist.  `time` defaults to
 *              `now()` at the DB level when omitted.
 */
export async function appendTaskTelemetry(
  tx: Tx,
  row: {
    taskId: number
    agentId: number | null
    keyspaceProgress: unknown
    speedHs?: number | null
    temperature?: number | null
  }
): Promise<void> {
  const insert: InsertTaskTelemetry = {
    taskId: row.taskId,
    agentId: row.agentId ?? null,
    keyspaceProgress: coerceToBigint(row.keyspaceProgress),
    speedHs: row.speedHs ?? null,
    temperature: row.temperature ?? null,
  }

  await tx.insert(taskTelemetry).values(insert)
}
