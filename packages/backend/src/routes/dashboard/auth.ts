import { Hono } from 'hono';
import { requireSession } from '../../middleware/auth.js';
import {
  getUserApiKeyMetadata,
  getUserWithProjects,
  issueUserApiKey,
  revokeUserApiKey,
} from '../../services/auth.js';
import type { AppEnv } from '../../types.js';

const authRouter = new Hono<AppEnv>();

/**
 * GET /me -- returns the authenticated user's profile and project memberships.
 * Login/logout are now handled by BetterAuth at /api/auth/*.
 */
authRouter.get('/me', requireSession, async (c) => {
  const { userId } = c.get('currentUser');
  const result = await getUserWithProjects(userId);

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'User not found' } }, 404);
  }

  return c.json(result);
});

// ─── Account API Key ────────────────────────────────────────────────
//
// `POST /me/api-key`   issue or rotate (raw token returned once)
// `GET /me/api-key`    metadata only (never the token, never the hash)
// `DELETE /me/api-key` revoke

authRouter.post('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser');
  const { token, metadata } = await issueUserApiKey(userId);
  return c.json({ token, metadata });
});

authRouter.get('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser');
  const metadata = await getUserApiKeyMetadata(userId);
  return c.json(metadata);
});

authRouter.delete('/me/api-key', requireSession, async (c) => {
  const { userId } = c.get('currentUser');
  await revokeUserApiKey(userId);
  return new Response(null, { status: 204 });
});

export { authRouter as authRoutes };
