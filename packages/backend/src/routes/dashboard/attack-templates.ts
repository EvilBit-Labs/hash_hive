import {
  createAttackTemplateRequestSchema,
  hashTypes,
  maskLists,
  ruleLists,
  wordLists,
} from '@hashhive/shared'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'

import type { AppEnv } from '../../types.js'

import { db } from '../../db/index.js'
import { dashboardError } from '../../lib/dashboard-errors.js'
import { requireSession } from '../../middleware/auth.js'
import { requireMembershipRole, requireProjectAccess } from '../../middleware/rbac.js'
import {
  DASHBOARD_RESPONSE_REFS,
  sharedDashboardResponse,
  dashboardOpenApiHonoOptions,
} from '../../openapi/components.js'
import {
  createAttackTemplate,
  deleteAttackTemplate,
  DuplicateAttackTemplateNameError,
  extractAttackPayload,
  getAttackTemplateById,
  listAttackTemplates,
  updateAttackTemplate,
} from '../../services/attack-templates.js'
import { getResourceById } from '../../services/resources.js'

const attackTemplateRoutes = new OpenAPIHono<AppEnv>(dashboardOpenApiHonoOptions)

attackTemplateRoutes.use('*', requireSession)

// ─── Shared validation helpers ────────────────────────────────────

const updateTemplateSchema = createAttackTemplateRequestSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  })

const listTemplatesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
})

const templateIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

const importTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  mode: z.number().int().nonnegative(),
  hashTypeId: z.number().int().positive().nullable().optional(),
  wordlistId: z.number().int().positive().nullable().optional(),
  rulelistId: z.number().int().positive().nullable().optional(),
  masklistId: z.number().int().positive().nullable().optional(),
  advancedConfiguration: z.record(z.string(), z.unknown()).nullable().optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
})

type ResourceCheck = {
  id: number | null | undefined
  table: typeof wordLists | typeof ruleLists | typeof maskLists
  label: string
}

/**
 * Verify that every non-null resource ID belongs to the given project.
 * Returns the label of the first invalid resource, or null if all are valid.
 */
async function validateResourceOwnership(
  resources: ReadonlyArray<ResourceCheck>,
  projectId: number
): Promise<string | null> {
  for (const { id, table, label } of resources) {
    if (id == null) continue
    const row = await getResourceById(table, id, projectId)
    if (!row) return label
  }
  return null
}

/** Verify a hashTypeId exists in the global hash_types table. */
async function validateHashTypeId(hashTypeId: number | null | undefined): Promise<boolean> {
  if (hashTypeId == null) return true
  const [row] = await db
    .select({ id: hashTypes.id })
    .from(hashTypes)
    .where(eq(hashTypes.id, hashTypeId))
    .limit(1)
  return !!row
}

/** Shared resource + hashType validation for create/update. */
async function validateTemplateReferences(
  data: {
    hashTypeId?: number | null | undefined
    wordlistId?: number | null | undefined
    rulelistId?: number | null | undefined
    masklistId?: number | null | undefined
  },
  projectId: number
): Promise<{ code: string; message: string } | null> {
  if (!(await validateHashTypeId(data.hashTypeId))) {
    return { code: 'RESOURCE_NOT_FOUND', message: 'Referenced hashTypeId does not exist' }
  }

  const invalidResource = await validateResourceOwnership(
    [
      { id: data.wordlistId, table: wordLists, label: 'wordlistId' },
      { id: data.rulelistId, table: ruleLists, label: 'rulelistId' },
      { id: data.masklistId, table: maskLists, label: 'masklistId' },
    ],
    projectId
  )
  if (invalidResource) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      message: `Referenced ${invalidResource} does not exist in this project`,
    }
  }

  return null
}

// ─── Response shapes (passthrough; tighten in U4 if YAML diff demands) ─

const templateListResponseSchema = z
  .object({ templates: z.array(z.unknown()) })
  .passthrough()
  .openapi('AttackTemplateList')

const templateDetailResponseSchema = z
  .object({ template: z.unknown() })
  .passthrough()
  .openapi('AttackTemplateDetail')

const templateInstantiateResponseSchema = z
  .object({ attack: z.unknown() })
  .passthrough()
  .openapi('AttackTemplateInstantiated')

const templateDeleteResponseSchema = z
  .object({ deleted: z.boolean() })
  .openapi('AttackTemplateDeleted')

const sharedAuthResponses = {
  401: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.AuthRequired),
  403: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.Forbidden),
} as const

// ─── Attack Template CRUD ──────────────────────────────────────────

attackTemplateRoutes.use('/', requireProjectAccess())

const listTemplatesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['AttackTemplates'],
  summary: 'List attack templates in the active project with paging',
  security: [{ SessionCookie: [] }],
  request: { query: listTemplatesQuerySchema },
  responses: {
    200: {
      description: 'Page of attack templates.',
      content: { 'application/json': { schema: templateListResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(listTemplatesRoute, async (c) => {
  const { projectId } = c.get('scopedUser')!
  const { limit, offset } = c.req.valid('query')

  const result = await listAttackTemplates({ projectId, limit, offset })
  return c.json(result, 200)
})

const createTemplateRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['AttackTemplates'],
  summary: 'Create an attack template (admin / contributor only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: createAttackTemplateRequestSchema } } },
  },
  responses: {
    201: {
      description: 'Template created.',
      content: { 'application/json': { schema: templateDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'A template with the same name already exists in this project.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(createTemplateRoute, async (c) => {
  const data = c.req.valid('json')
  const { userId, projectId } = c.get('scopedUser')!

  const refError = await validateTemplateReferences(data, projectId)
  if (refError) {
    return c.json({ error: refError }, 404)
  }

  try {
    const template = await createAttackTemplate({ ...data, projectId, createdBy: userId })
    return c.json({ template }, 201)
  } catch (error) {
    if (error instanceof DuplicateAttackTemplateNameError) {
      return dashboardError(c, 409, 'DUPLICATE_NAME', error.message)
    }
    throw error
  }
})

// Import precedes /:id routes so it doesn't get swallowed by the id
// param. Same handler shape as create — only the route name differs.

const importTemplateRoute = createRoute({
  method: 'post',
  path: '/import',
  tags: ['AttackTemplates'],
  summary: 'Import a serialized attack template (admin / contributor only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    body: { content: { 'application/json': { schema: importTemplateSchema } } },
  },
  responses: {
    201: {
      description: 'Template imported.',
      content: { 'application/json': { schema: templateDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'A template with the same name already exists in this project.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(importTemplateRoute, async (c) => {
  const data = c.req.valid('json')
  const { userId, projectId } = c.get('scopedUser')!

  const refError = await validateTemplateReferences(data, projectId)
  if (refError) {
    return c.json({ error: refError }, 404)
  }

  try {
    const template = await createAttackTemplate({ ...data, projectId, createdBy: userId })
    return c.json({ template }, 201)
  } catch (error) {
    if (error instanceof DuplicateAttackTemplateNameError) {
      return dashboardError(c, 409, 'DUPLICATE_NAME', error.message)
    }
    throw error
  }
})

// ─── /:id routes ───────────────────────────────────────────────────

attackTemplateRoutes.use('/:id', requireProjectAccess())

const getTemplateRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['AttackTemplates'],
  summary: 'Get an attack template by id',
  security: [{ SessionCookie: [] }],
  request: { params: templateIdParamSchema },
  responses: {
    200: {
      description: 'Template details.',
      content: { 'application/json': { schema: templateDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(getTemplateRoute, async (c) => {
  const { id } = c.req.valid('param')
  const template = await getAttackTemplateById(id)

  if (!template) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const { projectId } = c.get('currentUser')
  if (template.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  return c.json({ template }, 200)
})

const updateTemplateRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['AttackTemplates'],
  summary: 'Update an attack template (admin / contributor only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: {
    params: templateIdParamSchema,
    body: { content: { 'application/json': { schema: updateTemplateSchema } } },
  },
  responses: {
    200: {
      description: 'Updated template.',
      content: { 'application/json': { schema: templateDetailResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    409: {
      description: 'Rename would collide with an existing template name.',
      content: { 'application/json': { schema: z.object({ error: z.unknown() }) } },
    },
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(updateTemplateRoute, async (c) => {
  const { id } = c.req.valid('param')
  const template = await getAttackTemplateById(id)

  if (!template) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const { projectId } = c.get('currentUser')
  if (template.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const data = c.req.valid('json')

  const refError = await validateTemplateReferences(data, projectId)
  if (refError) {
    return c.json({ error: refError }, 404)
  }

  try {
    const updated = await updateAttackTemplate(id, data)

    if (!updated) {
      return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
    }

    return c.json({ template: updated }, 200)
  } catch (error) {
    if (error instanceof DuplicateAttackTemplateNameError) {
      return dashboardError(c, 409, 'DUPLICATE_NAME', error.message)
    }
    throw error
  }
})

const deleteTemplateRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['AttackTemplates'],
  summary: 'Delete an attack template (admin / contributor only)',
  security: [{ SessionCookie: [] }],
  middleware: [requireMembershipRole('admin', 'contributor')] as const,
  request: { params: templateIdParamSchema },
  responses: {
    200: {
      description: 'Deletion acknowledged.',
      content: { 'application/json': { schema: templateDeleteResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.openapi(deleteTemplateRoute, async (c) => {
  const { id } = c.req.valid('param')
  const template = await getAttackTemplateById(id)

  if (!template) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const { projectId } = c.get('currentUser')
  if (template.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  await deleteAttackTemplate(id)
  return c.json({ deleted: true }, 200)
})

const instantiateTemplateRoute = createRoute({
  method: 'post',
  path: '/{id}/instantiate',
  tags: ['AttackTemplates'],
  summary: 'Build an attack payload from a template (no DB write)',
  security: [{ SessionCookie: [] }],
  request: { params: templateIdParamSchema },
  responses: {
    200: {
      description:
        'Attack payload ready to submit to POST /campaigns or POST /campaigns/{id}/attacks.',
      content: { 'application/json': { schema: templateInstantiateResponseSchema } },
    },
    400: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ValidationFailed),
    404: sharedDashboardResponse(DASHBOARD_RESPONSE_REFS.ResourceNotFound),
    ...sharedAuthResponses,
  },
})

attackTemplateRoutes.use('/:id/instantiate', requireProjectAccess())

attackTemplateRoutes.openapi(instantiateTemplateRoute, async (c) => {
  const { id } = c.req.valid('param')
  const template = await getAttackTemplateById(id)

  if (!template) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const { projectId } = c.get('currentUser')
  if (template.projectId !== projectId) {
    return dashboardError(c, 404, 'RESOURCE_NOT_FOUND', 'Attack template not found')
  }

  const attack = extractAttackPayload(template)
  return c.json({ attack }, 200)
})

export { attackTemplateRoutes }
