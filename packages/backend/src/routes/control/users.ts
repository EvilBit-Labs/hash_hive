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

import { projectUsers, users } from '@hashhive/shared'
import { selectUserSchema } from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, asc, count, eq } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { paginate, paginationQuerySchema } from '../../lib/pagination.js'
import { problemResponse } from '../../lib/problem-details.js'
import {
  CONTROL_RESPONSE_REFS,
  controlOpenApiHonoOptions,
  sharedControlResponse,
} from '../../openapi/components.js'
import { controlErrorResponse, requireProjectRole } from './helpers.js'

export const controlUserRoutes = new OpenAPIHono<AppEnv>(controlOpenApiHonoOptions)

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const userSchema = selectUserSchema.openapi('ControlUser')
const userListPageSchema = z
  .object({
    items: z.array(userSchema),
    total: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  })
  .openapi('ControlUserPage')

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Users'],
  summary: "Return the authenticated API-key caller's profile",
  security: [{ ControlApiKey: [] }],
  responses: {
    200: {
      description: 'Caller profile.',
      content: { 'application/json': { schema: userSchema } },
    },
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlUserRoutes.openapi(meRoute, async (c) => {
  try {
    const { userId } = c.get('currentUser')
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
      .limit(1)
    if (!row) return problemResponse(c, 404, 'not_found', 'user not found')
    return c.json(row, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const listUsersRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Users'],
  summary: 'List members of the active project (admin only)',
  description:
    'Scoped through `project_users` so a project admin can only see members of the active project, not every account in the system.',
  security: [{ ControlApiKey: [] }],
  request: { query: paginationQuerySchema },
  responses: {
    200: {
      description: 'Page of project members.',
      content: { 'application/json': { schema: userListPageSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlUserRoutes.openapi(listUsersRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin')
    const query = c.req.valid('query')

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
    ])

    return c.json(paginate(items, Number(totalRow[0]?.value ?? 0), query), 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})

const getUserRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Users'],
  summary: 'Get a project member by id (admin only)',
  security: [{ ControlApiKey: [] }],
  request: { params: idParamSchema },
  responses: {
    200: {
      description: 'Project member.',
      content: { 'application/json': { schema: userSchema } },
    },
    400: sharedControlResponse(CONTROL_RESPONSE_REFS.ValidationError),
    401: sharedControlResponse(CONTROL_RESPONSE_REFS.AuthError),
    403: sharedControlResponse(CONTROL_RESPONSE_REFS.Forbidden),
    404: sharedControlResponse(CONTROL_RESPONSE_REFS.NotFound),
    500: sharedControlResponse(CONTROL_RESPONSE_REFS.InternalError),
  },
})

controlUserRoutes.openapi(getUserRoute, async (c) => {
  try {
    const { projectId } = await requireProjectRole(c, 'admin')
    const { id } = c.req.valid('param')
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
      .limit(1)
    if (!row) return problemResponse(c, 404, 'not_found', 'user not found')
    return c.json(row, 200)
  } catch (err) {
    return controlErrorResponse(c, err)
  }
})
