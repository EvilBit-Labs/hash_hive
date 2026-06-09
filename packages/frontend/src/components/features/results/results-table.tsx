import type { CrackedResultRow } from '@hashhive/shared'

import { Link } from 'react-router'

import { EmptyState } from '../../ui/empty-state'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../../ui/table'

const PLACEHOLDER = '-'

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
  if (isLoading && rows.length === 0) {
    return <EmptyState message="Loading results..." />
  }

  if (!isLoading && rows.length === 0) {
    return <EmptyState message="No cracked results found." />
  }

  const showCampaign = columns !== 'no-campaign'
  const showHashList = columns !== 'no-hashlist'

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
        {rows.map((row) => (
          <TableRow key={row.id}>
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
            <Td className="text-xs text-muted-foreground" title={row.attackModeName ?? undefined}>
              {row.attackModeName ?? PLACEHOLDER}
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
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
