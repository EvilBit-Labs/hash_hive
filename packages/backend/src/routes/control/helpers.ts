/**
 * Shared helpers used by every Control API sub-router.
 *
 * Two responsibilities:
 *
 * 1. **Project scoping with membership enforcement.** `requireProjectMembership`
 *    looks up `findProjectMembership` for the active user + `X-Project-Id`
 *    pair and returns the membership row so route handlers can do role
 *    checks. The earlier `requireProjectId` helper trusted the header
 *    verbatim — that left every project-scoped Control route open to
 *    cross-project read/write. The new helper is the single trust gate.
 *
 * 2. **Uniform error mapping.** `controlErrorResponse` translates typed
 *    errors into RFC 9457 problem-detail responses without leaking raw
 *    exception messages on the 500 path.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { logger } from '../../config/logger.js';
import { mapZodError, problemResponse } from '../../lib/problem-details.js';
import { findProjectMembership } from '../../services/auth.js';
import type { AppEnv } from '../../types.js';

type Role = 'admin' | 'contributor' | 'viewer';

/** Throwable that maps cleanly to a problem-details response. */
export class ControlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | 'validation'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'project_not_selected',
    message: string
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

export interface ControlMembership {
  projectId: number;
  roles: string[];
}

/**
 * Resolve the active project id and verify the caller is a member.
 *
 * Throws `project_not_selected` (400) when the header is absent and
 * `forbidden` (403) when the caller is not a project member. Returns the
 * membership so the handler can do further role checks (e.g., admin only
 * for users listing, contributor or admin for write paths).
 */
export async function requireProjectMembership(c: Context<AppEnv>): Promise<ControlMembership> {
  const user = c.get('currentUser');
  const projectId = user.projectId;
  if (!projectId) {
    throw new ControlApiError(
      400,
      'project_not_selected',
      'No project selected — include X-Project-Id header'
    );
  }
  const membership = await findProjectMembership(user.userId, projectId);
  if (!membership) {
    throw new ControlApiError(403, 'forbidden', 'Not a member of this project');
  }
  return { projectId, roles: membership.roles ?? [] };
}

/**
 * Variant of `requireProjectMembership` that also enforces a role
 * requirement. Convenience for write/admin paths that should reject
 * viewer-role members.
 */
export async function requireProjectRole(
  c: Context<AppEnv>,
  ...roles: Role[]
): Promise<ControlMembership> {
  const membership = await requireProjectMembership(c);
  const ok = membership.roles.some((r) => roles.includes(r as Role));
  if (!ok) {
    throw new ControlApiError(403, 'forbidden', `Requires one of: ${roles.join(', ')}`);
  }
  return membership;
}

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export function parseIdParam(value: string | undefined): number {
  const parsed = idParamSchema.safeParse({ id: value });
  if (!parsed.success) {
    throw new ControlApiError(400, 'validation', 'id must be a positive integer');
  }
  return parsed.data.id;
}

/**
 * Centralized error → response mapping. Internal errors never leak the
 * raw exception message to the client (info disclosure risk on a
 * machine-readable surface) — they get a uniform "internal error"
 * envelope while the underlying cause is logged with the request id.
 */
export function controlErrorResponse(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ControlApiError) {
    return problemResponse(c, err.status, err.code, err.message);
  }
  if (err instanceof z.ZodError) {
    return problemResponse(c, 400, 'validation', 'Invalid request', mapZodError(err));
  }
  logger.error(
    {
      err,
      requestId: c.get('requestId'),
      path: c.req.path,
    },
    'control api unhandled error'
  );
  return problemResponse(c, 500, 'internal', 'An unexpected error occurred');
}
