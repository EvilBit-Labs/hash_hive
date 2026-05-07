import {
  type ApiKeyMetadata,
  type IssueApiKeyResponse,
  projects,
  projectUsers,
  users,
} from '@hashhive/shared';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { API_KEY_PREFIX, generateApiKey } from '../lib/api-key.js';

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

/**
 * Build the masked-prefix string shown to the user after the raw-token
 * reveal is dismissed. Single source of truth for both the issue path
 * (returned alongside the raw token) and the get-metadata path (returned
 * when the user revisits the page). Keeping these unified guards against
 * UI drift if the prefix shape ever changes.
 */
function prefixForUser(userId: number): string {
  return `${API_KEY_PREFIX}_${userId}_…`;
}

/**
 * Issue a new Control API key for the user, replacing any existing one.
 * Returns the raw token (shown once) plus metadata. The hash is the only
 * thing that gets persisted.
 */
export async function issueUserApiKey(userId: number): Promise<IssueApiKeyResponse> {
  const { token, hash } = await generateApiKey(userId);
  await db
    .update(users)
    .set({ apiKeyHash: hash, apiKeyLastUsedAt: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return {
    token,
    metadata: {
      hasKey: true,
      prefix: prefixForUser(userId),
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

  if (!row?.apiKeyHash) {
    return { hasKey: false };
  }
  return {
    hasKey: true,
    prefix: prefixForUser(userId),
    lastUsedAt: row.apiKeyLastUsedAt ? row.apiKeyLastUsedAt.toISOString() : null,
  };
}
