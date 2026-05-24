import * as schema from '@hashhive/shared'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env } from '../config/env.js'

const client = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
})

export const db = drizzle(client, { schema })
export { client }
