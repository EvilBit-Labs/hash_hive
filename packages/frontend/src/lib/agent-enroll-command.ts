/**
 * Single source of truth for the agent enrollment command shown across
 * the first-run surfaces (the enrollment-token reveal, the dashboard
 * "Awaiting first agent" hero, and the first-run checklist) so the three
 * never drift. The rebuilt Go agent conforms to this contract — it
 * accepts an enrollment token + server origin and exchanges them for its
 * long-lived bearer token on first connect.
 */

/** Placeholder shown when no concrete token is available yet. */
export const ENROLLMENT_TOKEN_PLACEHOLDER = '<ENROLLMENT_TOKEN>'

/**
 * Build the operator-facing `hashhive-agent enroll` command. Pass the
 * minted token to inline it; otherwise the placeholder is shown so the
 * operator knows where it goes.
 */
export function buildAgentEnrollCommand(
  serverOrigin: string,
  token: string = ENROLLMENT_TOKEN_PLACEHOLDER
): string {
  return [`hashhive-agent enroll \\`, `  --server ${serverOrigin} \\`, `  --token ${token}`].join(
    '\n'
  )
}
