import type { HashSearchResult } from '@hashhive/shared'

import { motion, useReducedMotion } from 'motion/react'

import { EASE_OUT_EXPO } from '../../../lib/motion-presets'
import { EmptyState } from '../../ui/empty-state'
import { Skeleton } from '../../ui/skeleton'
import { Table, TableBody, TableHead, Td, Th } from '../../ui/table'

const ROW_HOVER_VARS = '[--row-hover:hsl(var(--surface-0)/0.2)]'
const ROW_TRANSITION_DURATION_S = 0.2
const SKELETON_ROW_COUNT = 5

interface HashSearchTableProps {
  readonly rows: readonly HashSearchResult[]
  readonly isLoading: boolean
  readonly query: string
}

/**
 * Presentational table for global hash search results.
 *
 * Handles three inner states:
 *   - loading  → skeleton rows
 *   - empty    → "No matches found for {query}"
 *   - results  → motion.tr rows with crack-state styling
 *
 * The idle state (no query entered) is handled by the parent page.
 */
export function HashSearchTable({ rows, isLoading, query }: HashSearchTableProps) {
  const prefersReducedMotion = useReducedMotion()

  if (isLoading) {
    return (
      <output className="block space-y-2" aria-label="Loading search results">
        {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </output>
    )
  }

  if (rows.length === 0) {
    return <EmptyState message={`No matches found for "${query}"`} />
  }

  return (
    <Table>
      <TableHead>
        <tr>
          <Th>Hash Value</Th>
          <Th>Hash List</Th>
          <Th>Status</Th>
          <Th>Cracked At</Th>
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => {
          const isCracked = row.crackedAt !== null
          return (
            <motion.tr
              key={`${row.hashListId}:${row.hashValue}`}
              className={ROW_HOVER_VARS}
              animate={{ backgroundColor: 'transparent' }}
              whileHover={{ backgroundColor: 'var(--row-hover)' }}
              transition={
                prefersReducedMotion
                  ? { duration: 0 }
                  : { duration: ROW_TRANSITION_DURATION_S, ease: EASE_OUT_EXPO }
              }
            >
              <Td className="max-w-[300px] truncate font-mono text-xs text-muted-foreground">
                {row.hashValue}
              </Td>
              <Td className="text-xs text-muted-foreground">{row.hashListName}</Td>
              <Td>
                {isCracked ? (
                  <span className="text-xs font-medium text-success">Cracked</span>
                ) : (
                  <span className="text-xs text-muted-foreground">Uncracked</span>
                )}
              </Td>
              <Td className="text-xs text-muted-foreground">
                {row.crackedAt !== null ? new Date(row.crackedAt).toLocaleString() : '-'}
              </Td>
            </motion.tr>
          )
        })}
      </TableBody>
    </Table>
  )
}
