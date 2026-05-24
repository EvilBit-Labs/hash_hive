import Redis from 'ioredis'

import { env } from './env.js'
import { logger } from './logger.js'

export function createRedisClient(name: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
    retryStrategy(times: number) {
      const delay = Math.min(times * 500, 10_000)
      logger.warn({ name, attempt: times, delayMs: delay }, 'Redis reconnecting')
      return delay
    },
  })

  client.on('error', (err) => {
    logger.error({ err, name }, 'Redis connection error')
  })

  client.on('connect', () => {
    logger.info({ name }, 'Redis connected')
  })

  return client
}

export function getRedisStatus(client: Redis): 'connected' | 'disconnected' {
  return client.status === 'ready' ? 'connected' : 'disconnected'
}
