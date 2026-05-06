/**
 * Control API user endpoints. Self-read by default (`GET /users/me`);
 * full listing requires an admin role on the active project.
 */

import { users } from '@hashhive/shared';
import { count, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import { findProjectMembership } from '../../services/auth.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam } from './_shared.js';

export const controlUserRoutes = new Hono<AppEnv>();

const USER_ADMIN_ROLE = 'admin';

type GuardResult = { ok: true } | { ok: false; response: Response };

async function requireAdminOnActiveProject(c: Context<AppEnv>): Promise<GuardResult> {
  const user = c.get('currentUser');
  if (!user.projectId) {
    return {
      ok: false,
      response: problemResponse(
        c,
        400,
        'project_not_selected',
        'No project selected — include X-Project-Id header'
      ),
    };
  }
  const membership = await findProjectMembership(user.userId, user.projectId);
  if (!membership || !membership.roles.includes(USER_ADMIN_ROLE)) {
    return {
      ok: false,
      response: problemResponse(c, 403, 'forbidden', 'admin role required'),
    };
  }
  return { ok: true };
}

controlUserRoutes.get('/me', async (c) => {
  try {
    const { userId } = c.get('currentUser');
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        apiKeyLastUsedAt: users.apiKeyLastUsedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return problemResponse(c, 404, 'not_found', 'user not found');
    return c.json(row);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlUserRoutes.get('/', async (c) => {
  try {
    const guard = await requireAdminOnActiveProject(c);
    if (!guard.ok) return guard.response;
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const items = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .limit(query.limit)
      .offset(query.offset);
    const [totalRow] = await db.select({ value: count() }).from(users);
    return c.json(paginate(items, Number(totalRow?.value ?? 0), query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlUserRoutes.get('/:id', async (c) => {
  try {
    const guard = await requireAdminOnActiveProject(c);
    if (!guard.ok) return guard.response;
    const id = parseIdParam(c.req.param('id'));
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!row) return problemResponse(c, 404, 'not_found', 'user not found');
    return c.json(row);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
