import { projects, projectUsers, users } from '@hashhive/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { generateApiKey } from '../lib/api-key.js';

/** Checks if a user is a member of a project. Returns the membership row or null. */
export async function findProjectMembership(userId: number, projectId: number) {
  const [membership] = await db
    .select()
    .from(projectUsers)
    .where(and(eq(projectUsers.userId, userId), eq(projectUsers.projectId, projectId)))
    .limit(1);
  return membership ?? null;
}

export async function getUserWithProjects(userId: number) {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    return null;
  }

  const memberships = await db
    .select({
      projectId: projectUsers.projectId,
      roles: projectUsers.roles,
      projectName: projects.name,
      projectSlug: projects.slug,
    })
    .from(projectUsers)
    .innerJoin(projects, eq(projectUsers.projectId, projects.id))
    .where(eq(projectUsers.userId, userId));

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      status: user.status,
    },
    projects: memberships.map((m) => ({
      id: m.projectId,
      name: m.projectName,
      slug: m.projectSlug,
      roles: m.roles,
    })),
  };
}

// ─── API Key Management ─────────────────────────────────────────────

export interface ApiKeyMetadata {
  hasKey: boolean;
  prefix: string | null;
  lastUsedAt: string | null;
}

/**
 * Issue a new Control API key for the user, replacing any existing one.
 * Returns the raw token (shown once) plus metadata. The hash is the only
 * thing that gets persisted.
 */
export async function issueUserApiKey(
  userId: number
): Promise<{ token: string; metadata: ApiKeyMetadata }> {
  const { token, hash } = await generateApiKey(userId);
  await db
    .update(users)
    .set({ apiKeyHash: hash, apiKeyLastUsedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return {
    token,
    metadata: {
      hasKey: true,
      prefix: maskedPrefix(token),
      lastUsedAt: null,
    },
  };
}

export async function revokeUserApiKey(userId: number): Promise<void> {
  await db
    .update(users)
    .set({ apiKeyHash: null, apiKeyLastUsedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function getUserApiKeyMetadata(userId: number): Promise<ApiKeyMetadata> {
  const [row] = await db
    .select({
      apiKeyHash: users.apiKeyHash,
      apiKeyLastUsedAt: users.apiKeyLastUsedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || !row.apiKeyHash) {
    return { hasKey: false, prefix: null, lastUsedAt: null };
  }
  return {
    hasKey: true,
    prefix: `cst_${userId}_…`,
    lastUsedAt: row.apiKeyLastUsedAt ? row.apiKeyLastUsedAt.toISOString() : null,
  };
}

function maskedPrefix(token: string): string {
  // First two segments + ellipsis: matches the placeholder shown after the
  // raw-token reveal is dismissed.
  const firstSep = token.indexOf('_');
  const secondSep = token.indexOf('_', firstSep + 1);
  if (firstSep < 0 || secondSep < 0) return `${token.slice(0, 8)}…`;
  return `${token.slice(0, secondSep)}_…`;
}
