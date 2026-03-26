import { projectUsers } from '@hashhive/shared';
import { and, eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/index.js';
import type { AppEnv } from '../types.js';

type Role = 'admin' | 'contributor' | 'viewer';

function httpError(status: 401 | 403 | 400, code: string, message: string): HTTPException {
  return new HTTPException(status, {
    res: new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  });
}

async function checkMembership(c: {
  get: (key: 'currentUser') => { userId: number; projectId: number | null } | undefined;
}) {
  const user = c.get('currentUser');
  if (!user) {
    throw httpError(401, 'AUTH_TOKEN_INVALID', 'Authentication required');
  }

  const projectId = user.projectId;
  if (!projectId) {
    throw httpError(
      400,
      'PROJECT_NOT_SELECTED',
      'No project selected — call POST /projects/select first'
    );
  }

  const [membership] = await db
    .select()
    .from(projectUsers)
    .where(and(eq(projectUsers.userId, user.userId), eq(projectUsers.projectId, projectId)))
    .limit(1);

  if (!membership) {
    throw httpError(403, 'AUTHZ_PROJECT_ACCESS_DENIED', 'Not a member of this project');
  }

  return membership;
}

export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const membership = await checkMembership(c);
    const hasRole = membership.roles.some((r) => roles.includes(r as Role));
    if (!hasRole) {
      throw httpError(
        403,
        'AUTHZ_INSUFFICIENT_PERMISSIONS',
        `Requires one of: ${roles.join(', ')}`
      );
    }
    await next();
  });
}

export function requireProjectAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await checkMembership(c);
    await next();
  });
}

/**
 * Checks membership for a project specified by URL param (e.g., /:projectId).
 * Used for project management routes where the target project is in the URL.
 */
async function checkParamProjectMembership(c: {
  get: (key: 'currentUser') => { userId: number; projectId: number | null } | undefined;
  req: { param: (key: string) => string | undefined };
}) {
  const user = c.get('currentUser');
  if (!user) {
    throw httpError(401, 'AUTH_TOKEN_INVALID', 'Authentication required');
  }

  const projectId = Number(c.req.param('projectId'));
  if (!projectId || Number.isNaN(projectId)) {
    throw httpError(400, 'VALIDATION_FAILED', 'Project ID is required for this operation');
  }

  const [membership] = await db
    .select()
    .from(projectUsers)
    .where(and(eq(projectUsers.userId, user.userId), eq(projectUsers.projectId, projectId)))
    .limit(1);

  if (!membership) {
    throw httpError(403, 'AUTHZ_PROJECT_ACCESS_DENIED', 'Not a member of this project');
  }

  return membership;
}

export function requireParamProjectAccess() {
  return createMiddleware<AppEnv>(async (c, next) => {
    await checkParamProjectMembership(c);
    await next();
  });
}

export function requireParamProjectRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const membership = await checkParamProjectMembership(c);
    const hasRole = membership.roles.some((r) => roles.includes(r as Role));
    if (!hasRole) {
      throw httpError(
        403,
        'AUTHZ_INSUFFICIENT_PERMISSIONS',
        `Requires one of: ${roles.join(', ')}`
      );
    }
    await next();
  });
}
