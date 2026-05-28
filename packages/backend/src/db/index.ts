import * as schema from '@hashhive/shared'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { env } from '../config/env.js'

// Pool sizing is env-tunable. Defaults (50 connections, 30s idle) are
// targeted at the dashboard + agent + control + BullMQ + heartbeat
// sweep mix on a single backend instance. See env.ts for guidance.
//
// Worker pool split is intentionally deferred: hash-list parser and
// heartbeat-monitor currently share this pool. If load tests show
// the streaming parser starving request handlers, introduce a
// second postgres() client in queue/manager.ts and have workers
// pass that down instead of importing the shared `db` here.
const client = postgres(env.DATABASE_URL, {
  max: env.DATABASE_POOL_MAX,
  idle_timeout: env.DATABASE_IDLE_TIMEOUT,
  connect_timeout: 10,
})

export const db = drizzle(client, { schema })
export { client }
