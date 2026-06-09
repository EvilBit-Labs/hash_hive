import type { CrackedResultRow } from '@hashhive/shared'

import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { Link } from 'react-router'

import { attackModeColorClass } from '../../../lib/attack-mode-color'
import { cn } from '../../../lib/utils'
import { EmptyState } from '../../ui/empty-state'
import { Table, TableBody, TableHead, Td, Th } from '../../ui/table'

const PLACEHOLDER = '-'

// Brief row-reveal pulse for newly arrived cracked results — the
// "moment a hash cracks" operator-theater moment .impeccable.md
// calls out. Catppuccin green-tinted background fades in over 1.2s.
const ROW_PULSE_DURATION_S = 1.2
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const
const ROW_PULSE_VARS =
  '[--pulse-on:hsl(var(--ctp-green)/0.2)] ' +
  '[--pulse-quiet:hsl(var(--ctp-green)/0.08)] ' +
  '[--pulse-off:hsl(var(--ctp-green)/0)] ' +
  '[--row-hover:hsl(var(--surface-0)/0.2)]'

export type ResultsTableColumns = 'full' | 'no-campaign' | 'no-hashlist'

interface ResultsTableProps {
  readonly rows: readonly CrackedResultRow[]
  readonly isLoading: boolean
  /**
   * Column-set override. `'full'` (default) renders all six columns:
   * Hash Value, Plaintext, Campaign, Attack, Hash List, Cracked At.
   * `'no-campaign'` drops the Campaign column for the campaign-detail
   * Results tab (the campaign is implied by the page context).
   * `'no-hashlist'` drops the Hash List column for the hash-list detail
   * Cracked view (the hash list is implied by the page context).
   */
  readonly columns?: ResultsTableColumns
}

/**
 * Presentational table for cracked results. Shared by three call sites:
 * the global `/results` page, the campaign detail Results tab, and the
 * hash list detail Cracked view. Each owns its own data fetching; this
 * component never calls TanStack Query — `rows` and `isLoading` are the
 * complete data contract.
 *
 * Plaintext is monospace and never masked; long values wrap with
 * `break-all`. Campaign and Hash List cells render `react-router` links
 * for attribution. The Attack column carries a native `title` tooltip
 * so the resolved attack-mode name is hoverable for future enrichment
 * with mask/wordlist summaries.
 */
export function ResultsTable({ rows, isLoading, columns = 'full' }: ResultsTableProps) {
  const prefersReducedMotion = useReducedMotion()

  // Track the largest row id we've ever seen so we can pulse only
  // rows that arrived after the previous render. Initial mount seeds
  // the value without flagging anything — the operator landing on a
  // populated table didn't just crack those rows.
  const maxSeenIdRef = useRef<number>(0)
  useEffect(() => {
    if (rows.length === 0) return
    const maxId = Math.max(...rows.map((r) => r.id))
    if (maxId > maxSeenIdRef.current) {
      maxSeenIdRef.current = maxId
    }
  }, [rows])

  if (isLoading && rows.length === 0) {
    // Initial load — the page chrome (header, LiveIndicator, filters)
    // already communicates "we're working on it." Echoing "Loading..."
    // here adds nothing the operator doesn't already see.
    return null
  }

  if (!isLoading && rows.length === 0) {
    return <EmptyState message="No cracks in the current filter." />
  }

  const showCampaign = columns !== 'no-campaign'
  const showHashList = columns !== 'no-hashlist'
  // Snapshot the threshold at render time. The useEffect updates the
  // ref AFTER paint so this read still reflects the previous max.
  const seenThreshold = maxSeenIdRef.current

  return (
    <Table>
      <TableHead>
        <tr>
          <Th>Hash Value</Th>
          <Th>Plaintext</Th>
          {showCampaign && <Th>Campaign</Th>}
          <Th>Attack</Th>
          {showHashList && <Th>Hash List</Th>}
          <Th>Cracked At</Th>
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => {
          const isNew = seenThreshold > 0 && row.id > seenThreshold
          const pulseAnimate = isNew
            ? prefersReducedMotion
              ? { backgroundColor: 'var(--pulse-quiet)' }
              : { backgroundColor: ['var(--pulse-on)', 'var(--pulse-off)'] }
            : { backgroundColor: 'var(--pulse-off)' }
          return (
            <motion.tr
              key={row.id}
              className={ROW_PULSE_VARS}
              animate={pulseAnimate}
              whileHover={{ backgroundColor: 'var(--row-hover)' }}
              transition={{ duration: ROW_PULSE_DURATION_S, ease: [...EASE_OUT_EXPO] }}
            >
              <Td className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                {row.hashValue}
              </Td>
              <Td className="font-mono text-sm font-medium break-all text-success">
                {row.plaintext ?? PLACEHOLDER}
              </Td>
              {showCampaign && (
                <Td className="text-xs text-muted-foreground">
                  {row.campaignId !== null && row.campaignName !== null ? (
                    <Link
                      to={`/campaigns/${row.campaignId}`}
                      className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {row.campaignName}
                    </Link>
                  ) : (
                    (row.campaignName ?? PLACEHOLDER)
                  )}
                </Td>
              )}
              <Td className="text-xs" title={row.attackModeName ?? undefined}>
                {row.attackModeName === null ? (
                  <span className="text-muted-foreground">{PLACEHOLDER}</span>
                ) : (
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5',
                      attackModeColorClass(row.attackModeName)
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-current"
                    />
                    {row.attackModeName}
                  </span>
                )}
              </Td>
              {showHashList && (
                <Td className="text-xs text-muted-foreground">
                  <Link
                    to={`/hash-lists/${row.hashListId}`}
                    className="rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    {row.hashListName}
                  </Link>
                </Td>
              )}
              <Td className="text-xs text-muted-foreground">
                {row.crackedAt !== null ? new Date(row.crackedAt).toLocaleString() : PLACEHOLDER}
              </Td>
            </motion.tr>
          )
        })}
      </TableBody>
    </Table>
  )
}
