import {
  createAttackTemplateRequestSchema,
  hashTypes,
  maskLists,
  ruleLists,
  wordLists,
} from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { requireSession } from '../../middleware/auth.js';
import { requireProjectAccess, requireRole } from '../../middleware/rbac.js';
import {
  createAttackTemplate,
  DuplicateAttackTemplateNameError,
  deleteAttackTemplate,
  extractAttackPayload,
  getAttackTemplateById,
  listAttackTemplates,
  updateAttackTemplate,
} from '../../services/attack-templates.js';
import { getResourceById } from '../../services/resources.js';
import type { AppEnv } from '../../types.js';

const attackTemplateRoutes = new Hono<AppEnv>();

attackTemplateRoutes.use('*', requireSession);

// ─── Shared validation helpers ────────────────────────────────────

const updateTemplateSchema = createAttackTemplateRequestSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

const listTemplatesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const templateIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

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
});

type ResourceCheck = {
  id: number | null | undefined;
  table: typeof wordLists | typeof ruleLists | typeof maskLists;
  label: string;
};

/**
 * Verify that every non-null resource ID belongs to the given project.
 * Returns the label of the first invalid resource, or null if all are valid.
 */
async function validateResourceOwnership(
  resources: ReadonlyArray<ResourceCheck>,
  projectId: number
): Promise<string | null> {
  for (const { id, table, label } of resources) {
    if (id == null) continue;
    const row = await getResourceById(table, id, projectId);
    if (!row) return label;
  }
  return null;
}

/** Verify a hashTypeId exists in the global hash_types table. */
async function validateHashTypeId(hashTypeId: number | null | undefined): Promise<boolean> {
  if (hashTypeId == null) return true;
  const [row] = await db
    .select({ id: hashTypes.id })
    .from(hashTypes)
    .where(eq(hashTypes.id, hashTypeId))
    .limit(1);
  return !!row;
}

/** Shared resource + hashType validation for create/update. */
async function validateTemplateReferences(
  data: {
    hashTypeId?: number | null | undefined;
    wordlistId?: number | null | undefined;
    rulelistId?: number | null | undefined;
    masklistId?: number | null | undefined;
  },
  projectId: number
): Promise<{ code: string; message: string } | null> {
  if (!(await validateHashTypeId(data.hashTypeId))) {
    return { code: 'RESOURCE_NOT_FOUND', message: 'Referenced hashTypeId does not exist' };
  }

  const invalidResource = await validateResourceOwnership(
    [
      { id: data.wordlistId, table: wordLists, label: 'wordlistId' },
      { id: data.rulelistId, table: ruleLists, label: 'rulelistId' },
      { id: data.masklistId, table: maskLists, label: 'masklistId' },
    ],
    projectId
  );
  if (invalidResource) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      message: `Referenced ${invalidResource} does not exist in this project`,
    };
  }

  return null;
}

// ─── Attack Template CRUD ──────────────────────────────────────────

attackTemplateRoutes.get(
  '/',
  requireProjectAccess(),
  zValidator('query', listTemplatesQuerySchema),
  async (c) => {
    const { projectId } = c.get('currentUser');
    const { limit, offset } = c.req.valid('query');

    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    const result = await listAttackTemplates({ projectId, limit, offset });
    return c.json(result);
  }
);

attackTemplateRoutes.post(
  '/',
  requireRole('admin', 'contributor'),
  zValidator('json', createAttackTemplateRequestSchema),
  async (c) => {
    const data = c.req.valid('json');
    const { userId, projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    const refError = await validateTemplateReferences(data, projectId);
    if (refError) {
      return c.json({ error: refError }, 404);
    }

    try {
      const template = await createAttackTemplate({ ...data, projectId, createdBy: userId });
      return c.json({ template }, 201);
    } catch (error) {
      if (error instanceof DuplicateAttackTemplateNameError) {
        return c.json({ error: { code: 'DUPLICATE_NAME', message: error.message } }, 409);
      }
      throw error;
    }
  }
);

attackTemplateRoutes.get(
  '/:id',
  requireProjectAccess(),
  zValidator('param', templateIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const template = await getAttackTemplateById(id);

    if (!template) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const { projectId } = c.get('currentUser');
    if (template.projectId !== projectId) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    return c.json({ template });
  }
);

attackTemplateRoutes.patch(
  '/:id',
  requireRole('admin', 'contributor'),
  zValidator('param', templateIdParamSchema),
  zValidator('json', updateTemplateSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const template = await getAttackTemplateById(id);

    if (!template) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const { projectId } = c.get('currentUser');
    if (template.projectId !== projectId) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const data = c.req.valid('json');

    const refError = await validateTemplateReferences(data, projectId);
    if (refError) {
      return c.json({ error: refError }, 404);
    }

    try {
      const updated = await updateAttackTemplate(id, data);

      if (!updated) {
        return c.json(
          { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
          404
        );
      }

      return c.json({ template: updated });
    } catch (error) {
      if (error instanceof DuplicateAttackTemplateNameError) {
        return c.json({ error: { code: 'DUPLICATE_NAME', message: error.message } }, 409);
      }
      throw error;
    }
  }
);

attackTemplateRoutes.delete(
  '/:id',
  requireRole('admin', 'contributor'),
  zValidator('param', templateIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const template = await getAttackTemplateById(id);

    if (!template) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const { projectId } = c.get('currentUser');
    if (template.projectId !== projectId) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    await deleteAttackTemplate(id);
    return c.json({ deleted: true });
  }
);

// ─── Import (must precede /:id routes to avoid param conflict) ────

attackTemplateRoutes.post(
  '/import',
  requireRole('admin', 'contributor'),
  zValidator('json', importTemplateSchema),
  async (c) => {
    const data = c.req.valid('json');
    const { userId, projectId } = c.get('currentUser');
    if (!projectId) {
      return c.json(
        { error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } },
        400
      );
    }

    const refError = await validateTemplateReferences(data, projectId);
    if (refError) {
      return c.json({ error: refError }, 404);
    }

    try {
      const template = await createAttackTemplate({ ...data, projectId, createdBy: userId });
      return c.json({ template }, 201);
    } catch (error) {
      if (error instanceof DuplicateAttackTemplateNameError) {
        return c.json({ error: { code: 'DUPLICATE_NAME', message: error.message } }, 409);
      }
      throw error;
    }
  }
);

// ─── Instantiate ───────────────────────────────────────────────────

attackTemplateRoutes.post(
  '/:id/instantiate',
  requireProjectAccess(),
  zValidator('param', templateIdParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const template = await getAttackTemplateById(id);

    if (!template) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const { projectId } = c.get('currentUser');
    if (template.projectId !== projectId) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    const attack = extractAttackPayload(template);
    return c.json({ attack });
  }
);

export { attackTemplateRoutes };
