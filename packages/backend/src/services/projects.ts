import { baSessions, projects, projectUsers, users } from '@hashhive/shared'
import { and, count, desc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { recordAuditEvent } from './audit-log.js'

const DEFAULT_SYSTEM_ACTOR = { actorType: 'system' as const, actorId: null }

type Actor = { actorType: 'user' | 'agent' | 'system'; actorId: number | null }

export async function createProject(
  data: {
    name: string
    description?: string | undefined
    slug: string
    settings?: Record<string, unknown> | undefined
    createdBy: number
  },
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
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
      .returning()

    if (!project) {
      return null
    }

    // Add the creator as admin
    await tx.insert(projectUsers).values({
      userId: data.createdBy,
      projectId: project.id,
      roles: ['admin'],
    })

    await recordAuditEvent(
      {
        actor,
        projectId: project.id,
        entityType: 'project',
        entityId: project.id,
        action: 'created',
        newRow: project as Record<string, unknown>,
      },
      tx
    )

    return project
  })
}

export async function getProjectById(projectId: number) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  return project ?? null
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
    .where(eq(projectUsers.userId, userId))
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
    .limit(1)
  return row ?? null
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
  const whereClause = eq(projectUsers.userId, userId)
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
  ])
  return { items, total: Number(countResult[0]?.value ?? 0) }
}

/**
 * Wrapped in a transaction so the audit row is atomic with the UPDATE.
 * Fetches the old row inside the tx for the diff snapshot.
 */
export async function updateProject(
  projectId: number,
  data: {
    name?: string | undefined
    description?: string | undefined
    settings?: Record<string, unknown> | undefined
  },
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  return db.transaction(async (tx) => {
    const [oldRow] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1)

    if (!oldRow) {
      return null
    }

    const [updated] = await tx
      .update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning()

    if (!updated) {
      return null
    }

    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        oldRow: oldRow as Record<string, unknown>,
        newRow: updated as Record<string, unknown>,
      },
      tx
    )

    return updated
  })
}

/**
 * Wrapped in a transaction so the audit row is atomic with the INSERT.
 * Records the new member's userId and roles (no email — R6).
 */
export async function addUserToProject(
  projectId: number,
  userId: number,
  roles: string[],
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  return db.transaction(async (tx) => {
    const [membership] = await tx
      .insert(projectUsers)
      .values({ projectId, userId, roles })
      .returning()

    if (!membership) {
      return null
    }

    // Record membership addition as a project-level 'updated' event.
    // Diff captures the affected member's userId and roles.
    // userId only (not email) per R6 — no credential/PII in changes.
    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        oldRow: { memberUserId: null, memberRoles: null },
        newRow: { memberUserId: userId, memberRoles: roles },
      },
      tx
    )

    return membership
  })
}

export async function removeUserFromProject(
  projectId: number,
  userId: number,
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  // Wrap the membership delete and session-scope cleanup in a transaction
  // so a partial failure leaves neither side stale. Without the session
  // cleanup, a user whose membership is revoked stays wedged on the
  // dashboard with session.projectId still pointing at the (now
  // forbidden) project until their cookie session expires (8h) -- every
  // request 403s with no in-app recovery. Issue #159 adversarial
  // finding adv-001.
  //
  // We null `session.projectId` (rather than DELETE the session row)
  // so the user keeps their auth state and the dashboard routes them to
  // the project selector instead of forcing a re-sign-in. Also clears
  // `users.last_project_id` if it pointed at this project so the next
  // sign-in's session.create.before hook doesn't try to rehydrate a
  // project the user no longer has membership in (the membership-check
  // branch would catch it, but clearing the preference is cleaner).
  return db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(projectUsers)
      .where(and(eq(projectUsers.projectId, projectId), eq(projectUsers.userId, userId)))
      .returning()
    if (!removed) {
      return null
    }
    await tx
      .update(baSessions)
      .set({ projectId: null })
      .where(and(eq(baSessions.userId, userId), eq(baSessions.projectId, projectId)))
    await tx
      .update(users)
      .set({ lastProjectId: null })
      .where(and(eq(users.id, userId), eq(users.lastProjectId, projectId)))

    // Record membership removal as a project-level 'updated' event.
    // Captures the removed member's userId (not email) per R6.
    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        oldRow: { memberUserId: userId, memberRoles: removed.roles },
        newRow: { memberUserId: null, memberRoles: null },
      },
      tx
    )

    return removed
  })
}

export async function getProjectMembers(projectId: number) {
  return db
    .select({
      userId: projectUsers.userId,
      roles: projectUsers.roles,
      createdAt: projectUsers.createdAt,
    })
    .from(projectUsers)
    .where(eq(projectUsers.projectId, projectId))
}

/**
 * Wrapped in a transaction so the audit row is atomic with the UPDATE.
 * Fetches the old membership row first for the old->new role diff.
 * Captures userId only (not email) per R6.
 */
export async function updateMemberRoles(
  projectId: number,
  userId: number,
  roles: string[],
  actor: Actor = DEFAULT_SYSTEM_ACTOR
) {
  return db.transaction(async (tx) => {
    const [oldMembership] = await tx
      .select()
      .from(projectUsers)
      .where(and(eq(projectUsers.projectId, projectId), eq(projectUsers.userId, userId)))
      .limit(1)

    if (!oldMembership) {
      return null
    }

    const [updated] = await tx
      .update(projectUsers)
      .set({ roles })
      .where(and(eq(projectUsers.projectId, projectId), eq(projectUsers.userId, userId)))
      .returning()

    if (!updated) {
      return null
    }

    // Record role change as a project-level 'updated' event.
    // Diff captures the member's userId and old->new roles.
    // userId only — no email or credential per R6.
    await recordAuditEvent(
      {
        actor,
        projectId,
        entityType: 'project',
        entityId: projectId,
        action: 'updated',
        oldRow: { memberUserId: userId, memberRoles: oldMembership.roles },
        newRow: { memberUserId: userId, memberRoles: roles },
      },
      tx
    )

    return updated
  })
}
