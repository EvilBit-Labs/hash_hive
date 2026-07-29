import type { CampaignAttackRow, HashListSummary } from '@hashhive/shared'

import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'

import { CampaignAgentsSection } from '../components/features/campaign-agents-section'
import { CampaignTaskStats } from '../components/features/campaign-task-stats'
import { PermissionGuard } from '../components/features/permission-guard'
import { PriorityBadge } from '../components/features/priority-badge'
import { CrackedStatsLine } from '../components/features/results/cracked-stats-line'
import { LiveIndicator } from '../components/features/results/live-indicator'
import { ResultsTable } from '../components/features/results/results-table'
import { StatusBadge } from '../components/features/status-badge'
import { Button } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { ProgressBar } from '../components/ui/progress-bar'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { Tabs } from '../components/ui/tabs'
import { TextLink } from '../components/ui/text-link'
import { useCampaignDelete, useCampaignLifecycle } from '../hooks/use-campaigns'
import { useCampaignDetail } from '../hooks/use-dashboard'
import { useHashListSummaries } from '../hooks/use-hash-lists'
import { useResults } from '../hooks/use-results'
import { formatAttackEta, formatAttackKeyspace } from '../lib/attack-format'
import { formatCampaignEta } from '../lib/campaign-eta-display'
import { readCampaignPercentage } from '../lib/campaign-progress'
import { RESULTS_POLL_INTERVAL_MS } from '../lib/motion-presets'
import { Permission } from '../lib/permissions'

// Lazy-load the DAG view so reactflow's bundle weight is only paid when
// the detail page is actually visited.
const CampaignDagView = lazy(() =>
  import('../components/features/campaign-dag-view').then((m) => ({
    default: m.CampaignDagView,
  }))
)

type ConfirmAction = 'stop' | 'delete' | null

/**
 * Render the keyspace cell with three honest empty states (issues #99, #230):
 *  - a value -> formatted, exact value in the title;
 *  - null and `keyspacePending` -> a count/compute is genuinely in flight;
 *  - null and not pending -> truly uncomputable.
 *
 * `keyspacePending` is computed server-side (it is mode/source-aware: a stray
 * wordlist on a mask attack or a masklist that settled to a null keyspace are
 * both not pending), so the cell no longer guesses from `wordlistId`.
 */
function renderKeyspaceCell(attack: CampaignAttackRow) {
  const formatted = formatAttackKeyspace(attack.keyspace)
  if (formatted !== null) {
    return (
      <span className="tabular-nums" title={attack.keyspace ?? undefined}>
        {formatted}
      </span>
    )
  }
  if (attack.keyspacePending) {
    return <span className="text-muted-foreground italic">Computing...</span>
  }
  return (
    <span className="text-muted-foreground" title="Keyspace not computable for this attack">
      --
    </span>
  )
}

/**
 * Render the ETA cell: a counting-down duration when computable, else `--` with
 * a reason (no fleet benchmarks for the mode yet vs. no keyspace to estimate
 * from).
 */
function renderEtaCell(attack: CampaignAttackRow) {
  const eta = formatAttackEta(attack.estimatedSecondsRemaining)
  if (eta !== null) {
    return <span title="Estimate; updates as benchmarks and fleet size change">{eta}</span>
  }
  return (
    <span
      title={
        attack.keyspace !== null ? 'No agent benchmarks for this mode yet' : 'No estimate available'
      }
    >
      --
    </span>
  )
}

type CampaignDetailTab = 'attacks' | 'results'

const VALID_TABS: ReadonlySet<CampaignDetailTab> = new Set(['attacks', 'results'])
const DEFAULT_TAB: CampaignDetailTab = 'attacks'
const RESULTS_PAGE_SIZE = 100

function safeTab(raw: string | null): CampaignDetailTab {
  if (raw && VALID_TABS.has(raw as CampaignDetailTab)) {
    return raw as CampaignDetailTab
  }
  return DEFAULT_TAB
}

interface CampaignResultsPanelProps {
  // Nullable since #101: a super PARENT campaign has no single hash list
  // (`hashListId` is null). A null id simply matches no summary row, so the
  // stats card renders just the cracked count — never "Hash list #null".
  readonly campaignHashListId: number | null
  readonly hashLists: readonly HashListSummary[] | undefined
  readonly resultsTotal: number
  readonly rows: Parameters<typeof ResultsTable>[0]['rows']
  readonly isLoading: boolean
  readonly offset: number
  readonly onOffsetChange: (next: number) => void
  readonly isError?: boolean
  readonly error?: Error | null
}

/**
 * Co-located presentation for the Results tab. Lifted into its own
 * function so the parent's render body stays scannable; not exported
 * because no other surface needs this exact shape (the global Results
 * page has its own filter chrome, and the hash list detail view uses
 * a different segmented control).
 *
 * Hash list size is looked up from the project-scoped `useHashListSummaries()`
 * call at the parent. When the lookup hasn't returned (or returned no
 * matching row), `totalHashes` is omitted so the stats card renders
 * just the cracked count rather than a misleading 100% rate.
 */
function CampaignResultsPanel({
  campaignHashListId,
  hashLists,
  resultsTotal,
  rows,
  isLoading,
  offset,
  onOffsetChange,
  isError,
  error,
}: CampaignResultsPanelProps) {
  const matchedHashList = hashLists?.find((hl) => hl.id === campaignHashListId)
  const totalHashes = matchedHashList?.hashCount

  const hasNext = offset + RESULTS_PAGE_SIZE < resultsTotal
  const hasPrev = offset > 0
  const rangeStart = resultsTotal === 0 ? 0 : offset + 1
  const rangeEnd = Math.min(offset + RESULTS_PAGE_SIZE, resultsTotal)

  return (
    <div aria-live="polite" className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <CrackedStatsLine
          cracked={resultsTotal}
          {...(totalHashes !== undefined && { total: totalHashes })}
        />
        <LiveIndicator />
      </div>

      {isError && (
        <ErrorBanner
          message={error instanceof Error ? error.message : 'Failed to load campaign results'}
        />
      )}

      <ResultsTable rows={rows} isLoading={isLoading} columns="no-campaign" />

      {rows.length > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground tabular-nums">
            {rangeStart}-{rangeEnd} of {resultsTotal.toLocaleString('en-US')}
          </span>
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasPrev}
              onClick={() => onOffsetChange(Math.max(0, offset - RESULTS_PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!hasNext}
              onClick={() => onOffsetChange(offset + RESULTS_PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>()
  const campaignId = Number(id)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const tab = safeTab(searchParams.get('tab'))

  const handleTabChange = useCallback(
    (next: string) => {
      const nextTab = safeTab(next)
      const params = new URLSearchParams(searchParams)
      // Keep the URL clean: omit `tab` when it equals the implicit
      // default so a fresh /campaigns/:id link stays parameter-free
      // and `Back to campaigns` doesn't leak a tab pin across pages.
      if (nextTab === DEFAULT_TAB) params.delete('tab')
      else params.set('tab', nextTab)
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  const { data, isLoading, isError, error } = useCampaignDetail(campaignId)
  const lifecycle = useCampaignLifecycle()
  const del = useCampaignDelete()

  // Results pagination is local component state — the global Results
  // page (U7) anchors `offset` in the URL because of deep-linking from
  // filter changes, but the campaign-scoped tab is a navigational dead
  // end and doesn't need the same shareability.
  const [resultsOffset, setResultsOffset] = useState(0)

  // Hash lists are project-scoped; gate the fetch on the Results tab so
  // the Attacks tab doesn't pay the request cost just to render the
  // header. The campaign detail page is mounted in both tabs, so this
  // hook still has to live at the top level of the component.
  const { data: hashListsData } = useHashListSummaries({ enabled: tab === 'results' })

  // Same gate for the results query — TanStack Query won't fire when
  // `enabled` is false, but the call site still needs to opt in by way
  // of `useResults`'s own `enabled` (project-scoped). On the Attacks
  // tab the query is silent until the user switches over.
  const resultsQueryOptions = useMemo(
    () => ({
      campaignId,
      limit: RESULTS_PAGE_SIZE,
      offset: resultsOffset,
      refetchInterval: RESULTS_POLL_INTERVAL_MS,
      enabled: tab === 'results',
    }),
    [campaignId, resultsOffset, tab]
  )
  const {
    data: resultsData,
    isLoading: resultsLoading,
    isError: resultsIsError,
    error: resultsError,
  } = useResults(resultsQueryOptions)

  // Real-time updates: the shared useEvents hook mounted by EventsProvider
  // (in AppLayout) already invalidates ['campaign', campaignId] for every
  // campaign_status and task_update event whose payload carries a matching
  // campaignId, so this detail page automatically refetches without a
  // local subscription.

  const [confirm, setConfirm] = useState<ConfirmAction>(null)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  function handleStart() {
    setErrorBanner(null)
    // The detail page already shows full campaign context, so Start does
    // not need an interstitial confirmation modal.
    lifecycle.mutate(
      { campaignId, action: 'start' },
      {
        onError: (err) => {
          // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
          console.error('[campaign-detail] start failed', { campaignId, err })
          setErrorBanner(err instanceof Error ? err.message : 'Failed to start campaign')
        },
      }
    )
  }

  function handlePause() {
    setErrorBanner(null)
    lifecycle.mutate(
      { campaignId, action: 'pause' },
      {
        onError: (err) => {
          // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
          console.error('[campaign-detail] pause failed', { campaignId, err })
          setErrorBanner(err instanceof Error ? err.message : 'Failed to pause campaign')
        },
      }
    )
  }

  async function confirmStop() {
    try {
      await lifecycle.mutateAsync({ campaignId, action: 'stop' })
      setConfirm(null)
    } catch (err) {
      // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
      console.error('[campaign-detail] stop failed', { campaignId, err })
      setErrorBanner(err instanceof Error ? err.message : 'Failed to stop campaign')
    }
  }

  async function confirmDelete() {
    try {
      await del.mutateAsync({ campaignId })
      setConfirm(null)
      void navigate('/campaigns')
    } catch (err) {
      // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
      console.error('[campaign-detail] delete failed', { campaignId, err })
      setErrorBanner(err instanceof Error ? err.message : 'Failed to delete campaign')
    }
  }

  function cancelConfirm() {
    if (lifecycle.isPending || del.isPending) return
    setConfirm(null)
  }

  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <ErrorBanner message="Invalid campaign id in URL." />
      </div>
    )
  }

  if (isLoading) {
    return <EmptyState message="Loading campaign..." />
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load campaign'} />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <EmptyState message="Campaign not found." />
      </div>
    )
  }

  const { campaign, attacks, taskStats, activeAgents, eta } = data
  const percentage = readCampaignPercentage(campaign.progress)
  const etaDisplay = formatCampaignEta(eta)

  const canStart = campaign.status === 'draft' || campaign.status === 'paused'
  const canPause = campaign.status === 'running'
  const canStop = campaign.status === 'running' || campaign.status === 'paused'
  const canDelete = campaign.status === 'draft'

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <TextLink to="/campaigns" back>
            Back to campaigns
          </TextLink>
          <PermissionGuard permission={Permission.AUDIT_LOG_VIEW}>
            <TextLink to={`/audit-logs?entityType=campaign&entityId=${campaignId}`}>
              Audit history
            </TextLink>
          </PermissionGuard>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <PageHeader>{campaign.name}</PageHeader>
            <StatusBadge status={campaign.status} />
            <PriorityBadge priority={campaign.priority} />
            {campaign.superHashListId != null && (
              <Link
                to={`/super-hash-lists/${campaign.superHashListId}`}
                className="inline-flex items-center gap-1.5 rounded border border-ctp-mauve/20 bg-ctp-mauve/15 px-2 py-0.5 text-[11px] font-medium text-ctp-mauve hover:bg-ctp-mauve/25"
                title="This campaign targets a super hash list"
              >
                SUPER · #{campaign.superHashListId}
              </Link>
            )}
          </div>
          <PermissionGuard permission={Permission.CAMPAIGN_EDIT}>
            <div className="flex flex-wrap gap-2">
              {canStart && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleStart}
                  disabled={lifecycle.isPending}
                >
                  {campaign.status === 'paused' ? 'Resume' : 'Start'}
                </Button>
              )}
              {canPause && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePause}
                  disabled={lifecycle.isPending}
                >
                  Pause
                </Button>
              )}
              {canStop && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirm('stop')}
                  disabled={lifecycle.isPending}
                >
                  Stop
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirm('delete')}
                  disabled={del.isPending}
                >
                  Delete
                </Button>
              )}
            </div>
          </PermissionGuard>
        </div>

        {campaign.description && (
          <p className="text-sm text-muted-foreground">{campaign.description}</p>
        )}
      </div>

      {errorBanner && <ErrorBanner message={errorBanner} />}

      <Tabs value={tab} onChange={handleTabChange} className="space-y-6">
        <Tabs.List aria-label="Campaign sections">
          <Tabs.Trigger value="attacks">Attacks</Tabs.Trigger>
          <Tabs.Trigger value="results">Results</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="attacks" className="space-y-6">
          <section aria-labelledby="progress-heading" className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 id="progress-heading" className="text-sm font-medium">
                Progress
              </h3>
              <p
                className="font-mono text-xs text-muted-foreground tabular-nums"
                title="Estimated time to exhaust the search across the remaining keyspace - not a promise of when a crack lands"
              >
                ETA: <span data-testid="campaign-eta">{etaDisplay}</span>
              </p>
            </div>
            <ProgressBar
              value={percentage}
              ariaLabel="Campaign overall progress"
              label={`${(percentage <= 1 ? percentage * 100 : percentage).toFixed(1)}% complete`}
            />
            <CampaignTaskStats stats={taskStats} />
          </section>

          <section aria-labelledby="active-agents-heading" className="space-y-3">
            <h3 id="active-agents-heading" className="text-sm font-medium">
              Active agents
            </h3>
            <CampaignAgentsSection agents={activeAgents} />
          </section>

          <section aria-labelledby="dag-heading" className="space-y-3">
            <h3 id="dag-heading" className="text-sm font-medium">
              Attack dependencies
            </h3>
            <Suspense fallback={<EmptyState message="Loading graph..." />}>
              <CampaignDagView attacks={attacks} />
            </Suspense>
          </section>

          <section aria-labelledby="attacks-heading" className="space-y-3">
            <h3 id="attacks-heading" className="text-sm font-medium">
              Attacks
            </h3>
            {attacks.length === 0 ? (
              <EmptyState message="No attacks configured." />
            ) : (
              <Table>
                <TableHead>
                  <tr>
                    <Th>ID</Th>
                    <Th>Mode</Th>
                    <Th>Status</Th>
                    <Th>Keyspace</Th>
                    <Th>ETA</Th>
                    <Th>Wordlist</Th>
                    <Th>Dependencies</Th>
                  </tr>
                </TableHead>
                <TableBody>
                  {attacks.map((attack) => (
                    <TableRow key={attack.id}>
                      <Td className="font-mono text-xs">{attack.id}</Td>
                      <Td className="font-mono text-xs font-medium">{attack.mode}</Td>
                      <Td>
                        <StatusBadge status={attack.status} />
                      </Td>
                      <Td className="max-w-[10rem] truncate font-mono text-xs">
                        {renderKeyspaceCell(attack)}
                      </Td>
                      <Td className="text-xs text-muted-foreground">{renderEtaCell(attack)}</Td>
                      <Td className="text-xs text-muted-foreground">
                        {attack.wordlistId ? `#${attack.wordlistId}` : '-'}
                      </Td>
                      <Td className="font-mono text-xs text-muted-foreground">
                        {attack.dependencies?.length ? attack.dependencies.join(', ') : 'None'}
                      </Td>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </Tabs.Content>

        <Tabs.Content value="results" className="space-y-4">
          <CampaignResultsPanel
            campaignHashListId={campaign.hashListId}
            hashLists={hashListsData?.hashLists}
            resultsTotal={resultsData?.total ?? 0}
            rows={resultsData?.results ?? []}
            isLoading={resultsLoading}
            offset={resultsOffset}
            onOffsetChange={setResultsOffset}
            isError={resultsIsError}
            error={resultsError instanceof Error ? resultsError : null}
          />
        </Tabs.Content>
      </Tabs>

      <div className="space-y-1 border-t border-surface-0/50 pt-4 text-xs text-muted-foreground">
        <p>Created {new Date(campaign.createdAt).toLocaleString()}</p>
        {campaign.startedAt && <p>Started {new Date(campaign.startedAt).toLocaleString()}</p>}
        {campaign.completedAt && <p>Completed {new Date(campaign.completedAt).toLocaleString()}</p>}
      </div>

      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop campaign?"
        message="This will cancel all running tasks and reset the campaign to draft status. In-flight work cannot be resumed."
        confirmLabel="Confirm Stop"
        destructive
        busy={lifecycle.isPending}
        onConfirm={confirmStop}
        onCancel={cancelConfirm}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete campaign?"
        message={`Permanently remove "${campaign.name}" and its attacks. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        busy={del.isPending}
        onConfirm={confirmDelete}
        onCancel={cancelConfirm}
      />
    </div>
  )
}
