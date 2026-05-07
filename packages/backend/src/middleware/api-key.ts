/**
 * Control API authentication middleware.
 *
 * Verifies a Bearer token of the form `cst_<userId>_<random>` against the
 * stored bcrypt hash on `users.api_key_hash`. On success it populates
 * `currentUser` with the same shape `requireSession` does, so the existing
 * `requireRole` / `requireProjectAccess` RBAC helpers compose unchanged.
 *
 * All failure modes return a uniform RFC 9457 `auth` problem to avoid
 * leaking which step rejected the request (existence of user, hash
 * present, etc.). To keep timing uniform, we always run a bcrypt compare
 * even when the user lookup misses or the row has no stored hash —
 * otherwise an attacker could distinguish "valid token format, unknown
 * userId" from "valid token format, real userId, wrong key" by latency
 * and enumerate which user ids have provisioned API keys.
 */

import { users } from '@hashhive/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { BCRYPT_COST, parseApiKey, verifyApiKey } from '../lib/api-key.js';
import { parseProjectIdHeader } from '../lib/headers.js';
import { problemResponse } from '../lib/problem-details.js';
import type { AppEnv } from '../types.js';

const ACTIVE_STATUS = 'active';

/**
 * Pre-computed bcrypt hash used as a timing sentinel on the user-missing
 * branch. Generated lazily once during the first import via top-level
 * await — adds ≈ one bcrypt cost (~250ms at cost 12) to cold start.
 * Acceptable because the alternative (lazy + cached on first miss)
 * leaks a one-time miss-vs-hit timing differential.
 *
 * The 32 random bytes are unguessable so the sentinel hash cannot be
 * replayed if the verify-then-discard logic is ever flattened. The
 * bcrypt cost MUST match BCRYPT_COST so timing stays uniform.
 */
const TIMING_SENTINEL_HASH = await Bun.password.hash(base64UrlRandom(32), {
  algorithm: 'bcrypt',
  cost: BCRYPT_COST,
});

function base64UrlRandom(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function authProblem(c: Context<AppEnv>): Response {
  return problemResponse(c, 401, 'auth', 'Invalid or missing API key');
}

export const requireApiKey = createMiddleware<AppEnv>(async (c, next): Promise<Response | void> => {
  const authHeader = c.req.header('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return authProblem(c);
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const parsed = parseApiKey(token);
  if (!parsed) return authProblem(c);

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      apiKeyHash: users.apiKeyHash,
    })
    .from(users)
    .where(eq(users.id, parsed.userId))
    .limit(1);

  const userMissing = !row || row.status !== ACTIVE_STATUS || !row.apiKeyHash;
  // Always run bcrypt to keep timing uniform across miss paths. We
  // verify against the real hash when the row is usable; otherwise we
  // verify against the sentinel and discard the result.
  const hashToVerify = userMissing ? TIMING_SENTINEL_HASH : (row?.apiKeyHash as string);
  const verified = await verifyApiKey(token, hashToVerify);

  if (userMissing || !verified) return authProblem(c);

  c.set('currentUser', {
    userId: row.id,
    email: row.email,
    projectId: parseProjectIdHeader(c.req.header('x-project-id')),
  });

  // Fire-and-forget last-used update. Air-gapped deployment, low
  // write volume, accuracy preferred over write amplification. The
  // write is observability-only; coupling auth latency to it would
  // mean a slow DB stalls every authenticated request even though
  // the credentials are already verified. Failures are logged but
  // never deny the request.
  db.update(users)
    .set({ apiKeyLastUsedAt: new Date() })
    .where(eq(users.id, row.id))
    .catch((err) => logger.warn({ err, userId: row.id }, 'apiKeyLastUsedAt update failed'));

  await next();
});
