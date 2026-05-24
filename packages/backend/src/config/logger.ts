import pino from 'pino'

import { env } from './env.js'

const options: pino.LoggerOptions = {
  level: env.LOG_LEVEL,
}

if (env.LOG_PRETTY) {
  options.transport = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  }
}

export const logger = pino(options)
