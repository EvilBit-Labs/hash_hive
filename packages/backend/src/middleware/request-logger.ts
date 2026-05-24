import { createMiddleware } from 'hono/factory'

import type { AppEnv } from '../types.js'

import { logger } from '../config/logger.js'

export const requestLogger = createMiddleware<AppEnv>(async (c, next) => {
  const path = c.req.path

  // Skip logging for high-frequency health checks
  if (path === '/health') {
    return next()
  }

  const start = Date.now()
  const method = c.req.method
  const requestId = c.get('requestId')

  logger.info({ method, path, requestId }, 'request started')

  await next()

  const duration = Date.now() - start
  const status = c.res.status

  logger.info({ method, path, status, duration, requestId }, 'request completed')
})
