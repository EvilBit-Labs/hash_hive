import type { DashboardErrorCode } from '@hashhive/shared'
/**
 * Dashboard API error envelope helper.
 *
 * Mirrors the Control API's `lib/problem-details.ts` shape: one helper
 * that emits the envelope, codes constrained to a union exported from
 * `@hashhive/shared` so the frontend can exhaustive-switch.
 *
 * Pre-helper, ~80 dashboard routes hand-rolled
 *   c.json({ error: { code, message } }, status)
 * with no codification of valid codes. Drift like `VALIDATION_ERROR`
 * vs `VALIDATION_FAILED` slipped in. This helper centralises both the
 * envelope shape and the code vocabulary.
 *
 * Status is a literal union so 418-style typos fail at build, not in
 * production. Add a new status here when a route genuinely needs one
 * (and the new status has a documented meaning).
 */
import type { Context } from 'hono'

import type { AppEnv } from '../types.js'

export type DashboardErrorStatus = 400 | 401 | 403 | 404 | 409 | 411 | 412 | 413 | 422 | 500 | 503

export function dashboardError(
  c: Context<AppEnv>,
  status: DashboardErrorStatus,
  code: DashboardErrorCode,
  message: string
) {
  return c.json({ error: { code, message } }, status)
}
