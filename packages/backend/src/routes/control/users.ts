/**
 * Control API user endpoints.
 *
 * - `GET /users/me` -- caller's own profile, no project scoping.
 * - `GET /users` -- members of the active project (admin-only). Listing
 *   is scoped through `project_users` so a project admin can only see
 *   members of the active project, not every account in the system.
 * - `GET /users/:id` -- single user, but only when that user is a member
 *   of the active project.
 */

import { projectUsers, users } from '@hashhive/shared';
import { and, asc, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { paginate, paginationQuerySchema } from '../../lib/pagination.js';
import { problemResponse } from '../../lib/problem-details.js';
import type { AppEnv } from '../../types.js';
import { controlErrorResponse, parseIdParam, requireProjectRole } from './helpers.js';

export const controlUserRoutes = new Hono<AppEnv>();

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
    const { projectId } = await requireProjectRole(c, 'admin');
    const query = paginationQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));

    const [items, totalRow] = await Promise.all([
      db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          status: users.status,
          createdAt: users.createdAt,
          roles: projectUsers.roles,
        })
        .from(users)
        .innerJoin(projectUsers, eq(projectUsers.userId, users.id))
        .where(eq(projectUsers.projectId, projectId))
        // Stable order so concurrent inserts/role changes don't shift
        // rows across pages. id ascends monotonically and is unique.
        .orderBy(asc(users.id))
        .limit(query.limit)
        .offset(query.offset),
      db.select({ value: count() }).from(projectUsers).where(eq(projectUsers.projectId, projectId)),
    ]);

    return c.json(paginate(items, Number(totalRow[0]?.value ?? 0), query));
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});

controlUserRoutes.get('/:id', async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin');
    const id = parseIdParam(c.req.param('id'));
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        status: users.status,
        createdAt: users.createdAt,
        roles: projectUsers.roles,
      })
      .from(users)
      .innerJoin(projectUsers, eq(projectUsers.userId, users.id))
      .where(and(eq(users.id, id), eq(projectUsers.projectId, projectId)))
      .limit(1);
    if (!row) return problemResponse(c, 404, 'not_found', 'user not found');
    return c.json(row);
  } catch (err) {
    return controlErrorResponse(c, err);
  }
});
