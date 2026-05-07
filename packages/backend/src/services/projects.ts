import { projects, projectUsers } from '@hashhive/shared';
import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';

export async function createProject(data: {
  name: string;
  description?: string | undefined;
  slug: string;
  settings?: Record<string, unknown> | undefined;
  createdBy: number;
}) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .insert(projects)
      .values({
        name: data.name,
        description: data.description ?? null,
        slug: data.slug,
        settings: data.settings ?? {},
        createdBy: data.createdBy,
      })
      .returning();

    if (!project) {
      return null;
    }

    // Add the creator as admin
    await tx.insert(projectUsers).values({
      userId: data.createdBy,
      projectId: project.id,
      roles: ['admin'],
    });

    return project;
  });
}

export async function getProjectById(projectId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return project ?? null;
}

export async function getUserProjects(userId: number) {
  return db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      settings: projects.settings,
      roles: projectUsers.roles,
      createdAt: projects.createdAt,
    })
    .from(projectUsers)
    .innerJoin(projects, eq(projectUsers.projectId, projects.id))
    .where(eq(projectUsers.userId, userId));
}

/**
 * Single-row lookup for "is project X visible to user Y" — does the
 * full join in one query instead of materializing every membership.
 * Returns the project row when the user is a member, `null` otherwise.
 * Same shape as a single element of `getUserProjects` so callers can
 * substitute it cleanly.
 */
export async function findUserProjectById(userId: number, projectId: number) {
  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      description: projects.description,
      settings: projects.settings,
      roles: projectUsers.roles,
      createdAt: projects.createdAt,
    })
    .from(projectUsers)
    .innerJoin(projects, eq(projectUsers.projectId, projects.id))
    .where(and(eq(projectUsers.userId, userId), eq(projects.id, projectId)))
    .limit(1);
  return row ?? null;
}

/**
 * Paginated variant of `getUserProjects` for the Control API. Returns
 * `{ items, total }` with a deterministic `(id desc)` order so
 * pagination is stable across new project creations.
 */
export async function getUserProjectsPaginated(
  userId: number,
  opts: { limit: number; offset: number }
) {
  const whereClause = eq(projectUsers.userId, userId);
  const [items, countResult] = await Promise.all([
    db
      .select({
        id: projects.id,
        name: projects.name,
        slug: projects.slug,
        description: projects.description,
        settings: projects.settings,
        roles: projectUsers.roles,
        createdAt: projects.createdAt,
      })
      .from(projectUsers)
      .innerJoin(projects, eq(projectUsers.projectId, projects.id))
      .where(whereClause)
      .orderBy(desc(projects.id))
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ value: count() }).from(projectUsers).where(whereClause),
  ]);
  return { items, total: Number(countResult[0]?.value ?? 0) };
}

export async function updateProject(
  projectId: number,
  data: {
    name?: string | undefined;
    description?: string | undefined;
    settings?: Record<string, unknown> | undefined;
  }
) {
  const [updated] = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(projects.id, projectId))
    .returning();

  return updated ?? null;
}

export async function addUserToProject(projectId: number, userId: number, roles: string[]) {
  const [membership] = await db
    .insert(projectUsers)
    .values({ projectId, userId, roles })
    .returning();

  return membership ?? null;
}

export async function removeUserFromProject(projectId: number, userId: number) {
  const [removed] = await db
    .delete(projectUsers)
    .where(and(eq(projectUsers.projectId, projectId), eq(projectUsers.userId, userId)))
    .returning();

  return removed ?? null;
}

export async function getProjectMembers(projectId: number) {
  return db
    .select({
      userId: projectUsers.userId,
      roles: projectUsers.roles,
      createdAt: projectUsers.createdAt,
    })
    .from(projectUsers)
    .where(eq(projectUsers.projectId, projectId));
}

export async function updateMemberRoles(projectId: number, userId: number, roles: string[]) {
  const [updated] = await db
    .update(projectUsers)
    .set({ roles })
    .where(and(eq(projectUsers.projectId, projectId), eq(projectUsers.userId, userId)))
    .returning();

  return updated ?? null;
}
