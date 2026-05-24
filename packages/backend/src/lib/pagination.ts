/**
 * Shared `offset`/`limit` pagination convention for the Control API.
 *
 * The dashboard API uses `page`/`pageSize`; the Control API intentionally
 * picks the offset/limit shape because it composes more naturally with
 * scripted automation (SQL-like, no surprise off-by-ones on page math).
 */

import { z } from 'zod'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const paginationQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

export type PaginationQuery = z.infer<typeof paginationQuerySchema>

export interface Paginated<T> {
  items: T[]
  total: number
  offset: number
  limit: number
}

export function paginate<T>(items: T[], total: number, query: PaginationQuery): Paginated<T> {
  return { items, total, offset: query.offset, limit: query.limit }
}
