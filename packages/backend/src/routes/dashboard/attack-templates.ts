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

attackTemplateRoutes.get('/', requireProjectAccess(), async (c) => {
  const { projectId } = c.get('currentUser');
  const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
  const offset = c.req.query('offset') ? Number(c.req.query('offset')) : undefined;

  if (!projectId) {
    return c.json({ error: { code: 'PROJECT_NOT_SELECTED', message: 'No project selected' } }, 400);
  }

  const result = await listAttackTemplates({ projectId, limit, offset });
  return c.json(result);
});

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

    const template = await createAttackTemplate({ ...data, projectId, createdBy: userId });
    return c.json({ template }, 201);
  }
);

attackTemplateRoutes.get('/:id', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
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
});

attackTemplateRoutes.patch(
  '/:id',
  requireRole('admin', 'contributor'),
  zValidator('json', updateTemplateSchema),
  async (c) => {
    const id = Number(c.req.param('id'));
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

    const updated = await updateAttackTemplate(id, data);

    if (!updated) {
      return c.json(
        { error: { code: 'RESOURCE_NOT_FOUND', message: 'Attack template not found' } },
        404
      );
    }

    return c.json({ template: updated });
  }
);

attackTemplateRoutes.delete('/:id', requireRole('admin', 'contributor'), async (c) => {
  const id = Number(c.req.param('id'));
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
});

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

    const template = await createAttackTemplate({ ...data, projectId, createdBy: userId });
    return c.json({ template }, 201);
  }
);

// ─── Instantiate ───────────────────────────────────────────────────

attackTemplateRoutes.post('/:id/instantiate', requireProjectAccess(), async (c) => {
  const id = Number(c.req.param('id'));
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
});

export { attackTemplateRoutes };
