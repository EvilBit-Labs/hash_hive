/**
 * Agent bearer token generation, parsing, and verification (S-H2).
 *
 * New tokens look like `agt_<agentId>_<random>` where:
 * - `agt` (agent token) is the format discriminator; the auth path
 *   branches on its presence to choose bcrypt-verify vs. the legacy
 *   plaintext column lookup.
 * - `<agentId>` is a routing hint so we can fetch the agent row in O(1)
 *   before doing the bcrypt compare. Trust still flows from the bcrypt
 *   verify, never from the agentId — the hint is not a secret.
 * - `<random>` is 32 random bytes encoded as base64url (43 chars).
 *
 * Hashes are stored using the same bcrypt cost as user passwords and
 * Control API keys (12), so a compromised hash store is no easier to
 * crack than a leaked password store.
 *
 * Mirrors the lib/api-key.ts shape exactly so the two surfaces don't
 * drift. Legacy plaintext tokens (UUIDs in `agents.auth_token`) continue
 * to work during the rotation window — see middleware/auth.ts for the
 * branching logic.
 */
import { logger } from '../config/logger.js'

const RANDOM_BYTES = 32

/**
 * Bcrypt cost factor for stored agent-token hashes. Matches the Control
 * API key cost so the timing profile of the two verify paths is
 * identical, and so neither surface becomes the weaker link.
 */
export const AGENT_TOKEN_BCRYPT_COST = 12

export const AGENT_TOKEN_PREFIX = 'agt' as const

export interface ParsedAgentToken {
  agentId: number
  remainder: string
}

export interface IssuedAgentToken {
  /** Raw token to deliver to the agent. Never persisted. */
  token: string
  /** Bcrypt hash to persist in `auth_token_hash`. */
  hash: string
}

/**
 * Issue a new agent bearer token for the given agent id. The raw token
 * is shown to the operator exactly once during rotation; only the
 * bcrypt hash is persisted.
 */
export async function generateAgentToken(agentId: number): Promise<IssuedAgentToken> {
  const random = base64UrlEncode(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)))
  const token = `${AGENT_TOKEN_PREFIX}_${agentId}_${random}`
  const hash = await Bun.password.hash(token, {
    algorithm: 'bcrypt',
    cost: AGENT_TOKEN_BCRYPT_COST,
  })
  return { token, hash }
}

/**
 * Strict parse of a bcrypt-format agent token. Returns null on any
 * deviation from the canonical `agt_<positive-int>_<non-empty>` shape so
 * callers do not have to defend against malformed input downstream.
 * A null return is not "auth failed" by itself — it means "this is not
 * a bcrypt-format token, try the legacy path".
 */
export function parseAgentToken(token: string): ParsedAgentToken | null {
  if (!token) return null
  const firstSep = token.indexOf('_')
  if (firstSep <= 0) return null
  const secondSep = token.indexOf('_', firstSep + 1)
  if (secondSep <= firstSep + 1) return null
  const prefix = token.slice(0, firstSep)
  const agentIdRaw = token.slice(firstSep + 1, secondSep)
  const remainder = token.slice(secondSep + 1)
  if (prefix !== AGENT_TOKEN_PREFIX) return null
  if (!remainder) return null
  if (!/^[1-9]\d*$/.test(agentIdRaw)) return null
  const agentId = Number(agentIdRaw)
  if (!Number.isInteger(agentId) || agentId <= 0 || agentId > Number.MAX_SAFE_INTEGER) {
    return null
  }
  return { agentId, remainder }
}

/**
 * Constant-time verify of a raw token against its stored bcrypt hash.
 * Returns false on any malformed input rather than throwing — the caller
 * should always treat a false return as "deny" without distinguishing
 * the failure mode (auth-error responses are uniform by design). A real
 * bcrypt failure (corrupt hash, runtime error) is logged so an opaque
 * deny does not eat operational signal.
 */
export async function verifyAgentTokenHash(token: string, hash: string): Promise<boolean> {
  if (!token || !hash) return false
  try {
    return await Bun.password.verify(token, hash)
  } catch (err) {
    logger.warn({ err }, 'Bun.password.verify threw for agent token — treating as auth failure')
    return false
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
