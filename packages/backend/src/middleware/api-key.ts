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
 * present, etc.).
 */

import { users } from '@hashhive/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { parseApiKey, verifyApiKey } from '../lib/api-key.js';
import { problemResponse } from '../lib/problem-details.js';
import type { AppEnv } from '../types.js';

const ACTIVE_STATUS = 'active';

function parseProjectIdHeader(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

  if (!row || row.status !== ACTIVE_STATUS || !row.apiKeyHash) {
    return authProblem(c);
  }

  const ok = await verifyApiKey(token, row.apiKeyHash);
  if (!ok) return authProblem(c);

  c.set('currentUser', {
    userId: row.id,
    email: row.email,
    projectId: parseProjectIdHeader(c.req.header('x-project-id')),
  });

  // Synchronous last-used update — internal/air-gapped system, accuracy
  // matters more than write amplification (see plan U5 rationale).
  try {
    await db.update(users).set({ apiKeyLastUsedAt: new Date() }).where(eq(users.id, row.id));
  } catch (err) {
    logger.warn({ err, userId: row.id }, 'apiKeyLastUsedAt update failed');
  }

  await next();
});
