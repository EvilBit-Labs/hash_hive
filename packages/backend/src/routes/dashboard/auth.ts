import { loginRequestSchema } from '@hashhive/shared';
import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { requireSession } from '../../middleware/auth.js';
import { getUserWithProjects, login } from '../../services/auth.js';
import type { AppEnv } from '../../types.js';

const auth = new Hono<AppEnv>();

auth.post('/login', zValidator('json', loginRequestSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  let result: Awaited<ReturnType<typeof login>>;
  try {
    result = await login(email, password);
  } catch (err) {
    logger.error({ err }, 'login failed due to internal error');
    return c.json(
      { error: { code: 'INTERNAL_SERVER_ERROR', message: 'Unable to process login request' } },
      500
    );
  }

  if (!result) {
    return c.json(
      { error: { code: 'VALIDATION_INVALID_CREDENTIALS', message: 'Invalid email or password' } },
      400
    );
  }

  setCookie(c, 'session', result.token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // 24 hours
  });

  return c.json({
    user: result.user,
    ...('selectedProjectId' in result && result.selectedProjectId
      ? { selectedProjectId: result.selectedProjectId }
      : {}),
  });
});

auth.post('/logout', requireSession, async (c) => {
  deleteCookie(c, 'session', { path: '/' });
  return c.json({ success: true });
});

auth.get('/me', requireSession, async (c) => {
  const { userId, projectId } = c.get('currentUser');
  const result = await getUserWithProjects(userId);

  if (!result) {
    return c.json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'User not found' } }, 404);
  }

  return c.json({
    ...result,
    ...(projectId ? { selectedProjectId: projectId } : {}),
  });
});

export { auth as authRoutes };
