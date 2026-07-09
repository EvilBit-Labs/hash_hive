/**
 * Shared helpers for the Agent API surface.
 *
 * Today's only export is `agentInternalError`, which centralizes the
 * `try { ... } catch { log + return 500 envelope }` pattern that
 * every authenticated agent route follows. Mirrors the control
 * surface's `controlErrorResponse` in `routes/control/helpers.ts`,
 * but emits the agent envelope (`{ error: { code, message } }`) instead
 * of the RFC 9457 problem-details shape.
 */

import type { Context } from 'hono'

import type { AppEnv } from '../../types.js'

import { logger } from '../../config/logger.js'

/**
 * Enumerated 500-tier coarse codes the agent surface emits. The full
 * set is also documented in `AGENT_RESPONSE_DESCRIPTIONS.ServerError`
 * (in `openapi/components.ts`); when a new route adds a new coarse
 * code, add it here AND there in the same change so the spec, the
 * type union, and the runtime emit stay in lockstep.
 *
 * `OPENAPI_SPEC_GENERATION_FAILED` is intentionally NOT in this union
 * — it's emitted by `mountCachedSpec`'s failure envelope on the
 * `GET /openapi.json` path only, not by any route handler that uses
 * this helper.
 */
export type AgentInternalErrorCode =
  | 'HEARTBEAT_ERROR'
  | 'TASK_ASSIGN_ERROR'
  | 'TASK_REPORT_ERROR'
  | 'TASK_ZAP_ERROR'
  | 'TASK_RESOURCES_ERROR'
  | 'ERROR_INGEST_ERROR'
  | 'BENCHMARK_ERROR'
  | 'RESOURCE_URL_ERROR'
  | 'CRACKER_UPDATE_ERROR'
  | 'ENROLL_ERROR'
  | 'CONFIG_FETCH_ERROR'

/**
 * Log a route-handler exception with the route's per-call context and
 * return the agent 500 envelope. Replaces the 8 inline `catch` blocks
 * in `routes/agent/index.ts`.
 *
 * **Wire contract.** Body is exactly `{ error: { code, message } }`.
 * No `timestamp` / `requestId` fields are added — those would shift
 * the envelope to the dashboard shape and break the agent contract
 * tests at `agent-api-contract.test.ts` (which assert those keys are
 * absent via `expectAgentFailureEnvelope`). The message is the
 * caller-supplied static string, not `err.message`, so internal
 * diagnostic detail does not leak to agents.
 *
 * **Log shape.** `{ err, ...logCtx }` — preserves every key the
 * existing log-shape assertions in `agent-api-contract.test.ts` check
 * for (e.g., `agentId`, `status`, `hasError`, `taskId`). Callers pass
 * `logCtx` as a flat object; the helper does not re-key or filter.
 */
export function agentInternalError(
  c: Context<AppEnv>,
  err: unknown,
  code: AgentInternalErrorCode,
  message: string,
  logCtx: Record<string, unknown>,
  logMessage: string
): Response {
  logger.error({ err, ...logCtx }, logMessage)
  return c.json({ error: { code, message } }, 500)
}
