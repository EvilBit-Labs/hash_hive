/**
 * Server-side error whitelist evaluation (U4 / R12, R13, R14, R16).
 *
 * Downgrading matched errors at every ingress site prevents a whitelisted
 * error from flipping agent status or contributing to the 24h error badge,
 * while still persisting the row so operators can audit it.
 *
 * The downgrade severity (`'info'`) is intentionally chosen because:
 *   - It is persistable: `agent_errors.severity` is varchar(20) with no enum
 *     constraint in the DB.
 *   - It is excluded from `FATAL_SEVERITIES` and `WARNING_SEVERITIES`
 *     (`services/agents.ts`), so the badge SQL's `count(*) FILTER` clause
 *     naturally ignores it without any change to the query.
 *   - `decideHeartbeatTransition` only flips to 'error' on severity === 'fatal';
 *     'info' is a non-fatal, non-warning value that passes through safely.
 *
 * Pure functions only here — the DB read (`resolveEffectiveWhitelist`) happens
 * at the call site so the helpers remain unit-testable without a database.
 */

/** Severity written to the row when an error matches the whitelist. */
export const WHITELISTED_SEVERITY = 'info' as const

/**
 * Review-recommended threshold: an agent whose whitelisted-error count (in the
 * 24h window) meets or exceeds this constant has `reviewRecommended = true` on
 * its list/detail row, signalling that its whitelist may need tightening.
 *
 * Kept deliberately low (10): whitelisting downgrades a matched error to a
 * non-counting severity, so a rig with an over-broad pattern (e.g. a short word
 * that substring-matches most error text) stays `online` with `errorCount24h=0`
 * and keeps receiving tasks. This signal is the safety net that surfaces such a
 * rig for operator review, so it must fire well before a genuinely-broken rig
 * has silently absorbed a full day of failures.
 */
export const REVIEW_RECOMMENDED_THRESHOLD = 10

/**
 * Return `true` when `message` contains at least one pattern from `whitelist`
 * as a case-insensitive substring.
 *
 * Guards:
 *   - An empty or whitespace-only pattern never matches (avoids matching every
 *     message when an operator accidentally adds a blank entry).
 *   - An empty whitelist array always returns `false`.
 */
export function matchesWhitelist(message: string, whitelist: string[]): boolean {
  if (whitelist.length === 0) return false
  const lowerMessage = message.toLowerCase()
  for (const pattern of whitelist) {
    const trimmed = pattern.trim()
    if (trimmed.length === 0) continue
    if (lowerMessage.includes(trimmed.toLowerCase())) return true
  }
  return false
}

/**
 * Input shape shared by all three ingress sites. The `context` field mirrors
 * the optional context accepted by `logAgentError`.
 */
export interface ErrorInput {
  severity: string
  message: string
  context?: Record<string, unknown> | undefined
}

/**
 * Returns a new `ErrorInput` object with the severity downgraded to
 * `WHITELISTED_SEVERITY` and `context.whitelisted` set to `true` when
 * `message` matches the whitelist. When the message does not match (or the
 * whitelist is empty), the original object is returned unchanged.
 *
 * The returned object is always a new object when matched (immutable update),
 * and the original is never mutated.
 */
export function downgradeIfWhitelisted(error: ErrorInput, whitelist: string[]): ErrorInput {
  if (!matchesWhitelist(error.message, whitelist)) {
    return error
  }

  return {
    ...error,
    severity: WHITELISTED_SEVERITY,
    context: {
      ...error.context,
      whitelisted: true,
    },
  }
}
