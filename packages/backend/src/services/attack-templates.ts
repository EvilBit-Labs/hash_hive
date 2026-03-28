import { attackTemplates } from '@hashhive/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export class DuplicateAttackTemplateNameError extends Error {
  constructor(name: string) {
    super(`An attack template named "${name}" already exists in this project`);
    this.name = 'DuplicateAttackTemplateNameError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

// ─── Attack Template CRUD ──────────────────────────────────────────

export async function listAttackTemplates(filters: {
  projectId: number;
  limit?: number | undefined;
  offset?: number | undefined;
}) {
  const conditions = [eq(attackTemplates.projectId, filters.projectId)];

  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  const whereClause = and(...conditions);

  const [templates, countResult] = await Promise.all([
    db
      .select()
      .from(attackTemplates)
      .where(whereClause)
      .limit(limit)
      .offset(offset)
      .orderBy(desc(attackTemplates.createdAt)),
    db.select({ count: sql<number>`count(*)` }).from(attackTemplates).where(whereClause),
  ]);

  return {
    templates,
    total: Number(countResult[0]?.count ?? 0),
    limit,
    offset,
  };
}

export async function getAttackTemplateById(id: number) {
  const [template] = await db
    .select()
    .from(attackTemplates)
    .where(eq(attackTemplates.id, id))
    .limit(1);
  return template ?? null;
}

export async function createAttackTemplate(data: {
  projectId: number;
  name: string;
  description?: string | null | undefined;
  mode: number;
  hashTypeId?: number | null | undefined;
  wordlistId?: number | null | undefined;
  rulelistId?: number | null | undefined;
  masklistId?: number | null | undefined;
  advancedConfiguration?: Record<string, unknown> | null | undefined;
  tags?: string[] | undefined;
  createdBy?: number | undefined;
}) {
  try {
    const [template] = await db
      .insert(attackTemplates)
      .values({
        projectId: data.projectId,
        name: data.name,
        description: data.description ?? null,
        mode: data.mode,
        hashTypeId: data.hashTypeId ?? null,
        wordlistId: data.wordlistId ?? null,
        rulelistId: data.rulelistId ?? null,
        masklistId: data.masklistId ?? null,
        advancedConfiguration:
          data.advancedConfiguration === undefined ? {} : data.advancedConfiguration,
        tags: data.tags ?? [],
        createdBy: data.createdBy ?? null,
      })
      .returning();

    return template ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateAttackTemplateNameError(data.name);
    }
    throw error;
  }
}

export async function updateAttackTemplate(
  id: number,
  data: {
    name?: string | undefined;
    description?: string | null | undefined;
    mode?: number | undefined;
    hashTypeId?: number | null | undefined;
    wordlistId?: number | null | undefined;
    rulelistId?: number | null | undefined;
    masklistId?: number | null | undefined;
    advancedConfiguration?: Record<string, unknown> | null | undefined;
    tags?: string[] | undefined;
  }
) {
  try {
    const [updated] = await db
      .update(attackTemplates)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(attackTemplates.id, id))
      .returning();

    return updated ?? null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateAttackTemplateNameError(data.name ?? '');
    }
    throw error;
  }
}

export async function deleteAttackTemplate(id: number) {
  const [deleted] = await db.delete(attackTemplates).where(eq(attackTemplates.id, id)).returning();
  return deleted ?? null;
}

/** Extract an attack-creation payload from an already-fetched template. */
export function extractAttackPayload(template: {
  mode: number;
  hashTypeId: number | null;
  wordlistId: number | null;
  rulelistId: number | null;
  masklistId: number | null;
  advancedConfiguration: unknown;
}) {
  return {
    mode: template.mode,
    hashTypeId: template.hashTypeId,
    wordlistId: template.wordlistId,
    rulelistId: template.rulelistId,
    masklistId: template.masklistId,
    advancedConfiguration: template.advancedConfiguration,
  };
}
