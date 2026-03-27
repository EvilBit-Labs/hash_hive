import { agents } from '@hashhive/shared';
import { eq } from 'drizzle-orm';
import { deleteCookie, getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { auth } from '../lib/auth.js';
import type { AppEnv } from '../types.js';

function authError(message: string): HTTPException {
  return new HTTPException(401, {
    res: new Response(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID', message } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

/**
 * Dashboard auth middleware -- validates BetterAuth session from cookie.
 * Sets currentUser on context with userId, email, and projectId from X-Project-Id header.
 *
 * Also cleans up legacy "session" cookies from the old JWT-based auth.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  // TODO: remove legacy cookie cleanup after first production deploy cycle (2026-Q2)
  const legacyCookie = getCookie(c, 'session');
  if (legacyCookie) {
    deleteCookie(c, 'session', { path: '/' });
  }

  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch (err) {
    logger.warn({ err }, 'BetterAuth getSession failed');
    throw authError('Authentication required');
  }
  if (!session) {
    throw authError('Authentication required');
  }

  // Read project context from X-Project-Id header (client-side project selection)
  const projectIdHeader = c.req.header('x-project-id');
  const projectId = projectIdHeader ? Number(projectIdHeader) : null;

  c.set('currentUser', {
    userId: Number(session.user.id),
    email: session.user.email,
    projectId: Number.isNaN(projectId) ? null : projectId,
  });
  await next();
});

/**
 * Agent auth middleware — validates pre-shared token from Authorization: Bearer header.
 * Queries the agents table directly and sets agent context (agentId, projectId, capabilities).
 */
export const requireAgentToken = createMiddleware<AppEnv>(async (c, next) => {
  const authHeader = c.req.header('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw authError('Bearer token required');
  }

  const token = authHeader.slice(7);

  const [agent] = await db
    .select({
      id: agents.id,
      projectId: agents.projectId,
      status: agents.status,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .where(eq(agents.authToken, token))
    .limit(1);

  if (!agent || agent.status === 'error') {
    throw authError('Invalid or expired agent token');
  }

  c.set('agent', {
    agentId: agent.id,
    projectId: agent.projectId,
    capabilities: (agent.capabilities ?? {}) as Record<string, unknown>,
  });
  await next();
});
