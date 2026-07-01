import { useState } from 'react'

import { HashSearchTable } from '../components/features/results/hash-search-table'
import { Button } from '../components/ui/button'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { Input } from '../components/ui/input'
import { PageHeader } from '../components/ui/page-header'
import { useDebounce } from '../hooks/use-debounce'
import { useHashSearch } from '../hooks/use-hash-search'
import { useUiStore } from '../stores/ui'

const SEARCH_DEBOUNCE_MS = 300
const IDLE_MESSAGE = "Enter a hash value to search across this project's lists"
const NO_PROJECT_MESSAGE = 'Select a project to search hashes'

/**
 * Global hash search page. Allows operators to search for a specific hash
 * value across all hash lists in the current project.
 *
 * States (in priority order):
 *   no-project → select-project prompt
 *   idle       → enter-query prompt (q is empty)
 *   error      → inline error with retry button
 *   loading    → skeleton rows (handled by HashSearchTable)
 *   empty      → no-matches message (handled by HashSearchTable)
 *   results    → results table (handled by HashSearchTable)
 */
export function HashSearchPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [rawQuery, setRawQuery] = useState('')
  const debouncedQuery = useDebounce(rawQuery, SEARCH_DEBOUNCE_MS)

  const trimmedQuery = debouncedQuery.trim()
  const isIdle = trimmedQuery.length === 0

  const { data, isLoading, isError, error, refetch } = useHashSearch(debouncedQuery)

  if (!selectedProjectId) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader>Hash Search</PageHeader>
        <EmptyState message={NO_PROJECT_MESSAGE} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader>Hash Search</PageHeader>

      <div className="flex items-center gap-3">
        <Input
          aria-label="Hash search query"
          placeholder="Search for a hash value..."
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
          className="max-w-lg"
        />
      </div>

      {isIdle && <EmptyState message={IDLE_MESSAGE} />}

      {!isIdle && isError && (
        <div className="flex flex-col gap-2">
          <ErrorBanner
            message={error instanceof Error ? error.message : 'Search failed. Please try again.'}
          />
          <div>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        </div>
      )}

      {!isIdle && !isError && (
        <HashSearchTable rows={data?.results ?? []} isLoading={isLoading} query={trimmedQuery} />
      )}
    </div>
  )
}
