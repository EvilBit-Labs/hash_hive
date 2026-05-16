/**
 * Control API key generation, parsing, and verification.
 *
 * Tokens look like `cst_<userId>_<random>` where:
 * - `cst` (control session token) lets the verifier pick the right code path.
 * - `<userId>` is a routing hint so we can look up the user row in O(1)
 *   before doing the bcrypt compare. Trust still flows from the bcrypt
 *   verification, never from the userId — the hint is not a secret.
 * - `<random>` is 32 random bytes encoded as base64url (43 chars).
 *
 * Hashes are stored using the same bcrypt cost as user passwords so a
 * compromised hash store is no easier to crack than a leaked password store.
 *
 * Security invariant: callers MUST follow `parseApiKey` with
 * `verifyApiKey(token, hashFromDb)`. `parseApiKey` returning a userId is
 * a parsing success, not authentication — only the bcrypt verify
 * establishes that the token belongs to the named user.
 */

import { logger } from '../config/logger.js';

const RANDOM_BYTES = 32;

/**
 * Bcrypt cost factor for stored API-key hashes. Exported so consumers
 * (notably the timing-sentinel hash in `requireApiKey`) cannot drift —
 * a sentinel computed at a different cost would defeat the
 * timing-uniformity goal it exists to serve.
 */
export const BCRYPT_COST = 12;

export const API_KEY_PREFIX = 'cst' as const;

export interface ParsedApiKey {
  userId: number;
  remainder: string;
}

export interface IssuedApiKey {
  token: string;
  hash: string;
}

/**
 * Issue a new API key for the given user. The raw token is shown to the
 * user once; only the bcrypt hash is persisted.
 */
export async function generateApiKey(userId: number): Promise<IssuedApiKey> {
  const random = base64UrlEncode(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
  const token = `${API_KEY_PREFIX}_${userId}_${random}`;
  const hash = await Bun.password.hash(token, { algorithm: 'bcrypt', cost: BCRYPT_COST });
  return { token, hash };
}

/**
 * Strict parse of a Control API token. Returns null on any deviation from
 * the canonical `cst_<positive-int>_<non-empty>` shape so callers do not
 * have to defend against malformed input downstream.
 */
export function parseApiKey(token: string): ParsedApiKey | null {
  if (!token) return null;
  const firstSep = token.indexOf('_');
  if (firstSep <= 0) return null;
  const secondSep = token.indexOf('_', firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const prefix = token.slice(0, firstSep);
  const userIdRaw = token.slice(firstSep + 1, secondSep);
  const remainder = token.slice(secondSep + 1);
  if (prefix !== API_KEY_PREFIX) return null;
  if (!remainder) return null;
  if (!/^[1-9]\d*$/.test(userIdRaw)) return null;
  const userId = Number(userIdRaw);
  // Reject ids that lose precision in double-precision FP — the integer
  // beyond Number.MAX_SAFE_INTEGER is no longer the exact value the
  // client sent, so a strict-equals lookup against the database id would
  // silently match the wrong row.
  if (!Number.isInteger(userId) || userId <= 0 || userId > Number.MAX_SAFE_INTEGER) return null;
  return { userId, remainder };
}

/**
 * Constant-time verify of a raw token against its stored bcrypt hash.
 * Returns false on any malformed input rather than throwing — the caller
 * should always treat a `false` return as "deny" without distinguishing
 * the failure mode (auth-error responses are uniform by design). A real
 * bcrypt failure (e.g. corrupt hash, runtime error) is logged so an
 * opaque deny does not eat operational signal.
 */
export async function verifyApiKey(token: string, hash: string): Promise<boolean> {
  if (!token || !hash) return false;
  try {
    return await Bun.password.verify(token, hash);
  } catch (err) {
    logger.warn({ err }, 'Bun.password.verify threw — treating as auth failure');
    return false;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
