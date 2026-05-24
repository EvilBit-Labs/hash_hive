import { createMiddleware } from 'hono/factory'

export const securityHeaders = createMiddleware(async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-DNS-Prefetch-Control', 'off')
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})
