import { campaignSortFieldSchema, campaignSortOrderSchema } from '@hashhive/shared'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import {
  type CampaignActionId,
  CampaignActionsMenu,
} from '../components/features/campaign-actions-menu'
import { PermissionGuard } from '../components/features/permission-guard'
import { PriorityBadge } from '../components/features/priority-badge'
import { StatusBadge } from '../components/features/status-badge'
import { buttonVariants } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { EmptyState } from '../components/ui/empty-state'
import { ErrorBanner } from '../components/ui/error-banner'
import { PageHeader } from '../components/ui/page-header'
import { ProgressBar } from '../components/ui/progress-bar'
import { Select } from '../components/ui/select'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { useCampaignDelete, useCampaignLifecycle } from '../hooks/use-campaigns'
import {
  type CampaignSortField,
  type CampaignSortOrder,
  type UseCampaignsOptions,
  useCampaigns,
} from '../hooks/use-dashboard'
import { readCampaignPercentage } from '../lib/campaign-progress'
import { Permission } from '../lib/permissions'
import { useUiStore } from '../stores/ui'

type ConfirmAction = 'start' | 'stop' | 'delete' | null
type LifecycleAction = 'start' | 'pause' | 'stop'

interface CampaignRow {
  id: number
  name: string
  status: string
  priority: number
  hashListId: number
  progress?: {
    percentage?: number
    overallProgress?: number
    hashProgress?: { percentage: number }
  } | null
  createdAt: string
}

const PRIORITY_FILTER_OPTIONS = [
  { label: 'All priorities', value: '' },
  { label: 'High', value: '1' },
  { label: 'Normal', value: '5' },
  { label: 'Low', value: '10' },
] as const

type CampaignPriorityValue = 1 | 5 | 10
const ALLOWED_PRIORITIES = new Set<CampaignPriorityValue>([1, 5, 10])

/**
 * Clamp the URL search params to the known allowlists before they
 * shape the API request. A malformed deep link (e.g. `?sort=evil`)
 * would otherwise reach the backend and return a 400, which the
 * dashboard renders as an empty state — indistinguishable from a real
 * empty result. Allowlist validation here lets the page fall back to
 * a safe default and emit a console warn so protocol drift is visible.
 */
function safeSortField(raw: string | null): CampaignSortField {
  const parsed = campaignSortFieldSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'createdAt'
}

function safeSortOrder(raw: string | null): CampaignSortOrder {
  const parsed = campaignSortOrderSchema.safeParse(raw)
  return parsed.success ? parsed.data : 'desc'
}

function safePriority(raw: string | null): CampaignPriorityValue | undefined {
  if (!raw) return undefined
  const n = Number(raw) as CampaignPriorityValue
  return Number.isInteger(n) && ALLOWED_PRIORITIES.has(n) ? n : undefined
}

const SORT_FIELD_OPTIONS: Array<{ label: string; value: CampaignSortField }> = [
  { label: 'Created', value: 'createdAt' },
  { label: 'Name', value: 'name' },
  { label: 'Priority', value: 'priority' },
]

export function CampaignsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Read raw params first, then sanitize. The raw values feed the
  // controlled-select state; the sanitized values feed the API call.
  const status = searchParams.get('status') ?? ''
  const priorityRaw = searchParams.get('priority') ?? ''
  const sortRaw = searchParams.get('sort')
  const orderRaw = searchParams.get('order')

  const sortParam = safeSortField(sortRaw)
  const orderParam = safeSortOrder(orderRaw)
  const priorityParam = safePriority(priorityRaw)

  const queryOptions = useMemo<UseCampaignsOptions>(() => {
    const opts: UseCampaignsOptions = { sort: sortParam, order: orderParam }
    if (status) opts.status = status
    if (priorityParam !== undefined) opts.priority = priorityParam
    return opts
  }, [status, priorityParam, sortParam, orderParam])

  const { data, isLoading, isError, error } = useCampaigns(queryOptions)

  // Real-time updates: the shared useEvents hook mounted by EventsProvider
  // (in AppLayout) already invalidates ['campaigns', selectedProjectId] on
  // every campaign_status and task_update event for the active project, so
  // this page automatically refetches without a local subscription.

  const [confirm, setConfirm] = useState<{ action: ConfirmAction; campaign: CampaignRow | null }>({
    action: null,
    campaign: null,
  })
  const [errorBanner, setErrorBanner] = useState<string | null>(null)

  const lifecycle = useCampaignLifecycle()
  const del = useCampaignDelete()

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  function handleAction(campaign: CampaignRow, action: CampaignActionId) {
    setErrorBanner(null)
    if (action === 'view') {
      void navigate(`/campaigns/${campaign.id}`)
      return
    }
    if (action === 'pause') {
      // Pause is spec'd to fire without a confirmation modal. Pass the
      // campaign id inline so the mutation targets this row directly.
      lifecycle.mutate(
        { campaignId: campaign.id, action: 'pause' },
        {
          onError: (err) => {
            // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
            console.error('[campaigns] pause failed', { campaignId: campaign.id, err })
            setErrorBanner(err instanceof Error ? err.message : 'Failed to pause campaign')
          },
        }
      )
      return
    }
    if (action === 'start' || action === 'stop' || action === 'delete') {
      setConfirm({ action, campaign })
    }
  }

  async function confirmAction() {
    if (!confirm.action || !confirm.campaign) return
    const { action, campaign } = confirm
    try {
      if (action === 'delete') {
        await del.mutateAsync({ campaignId: campaign.id })
      } else {
        const lifecycleAction: LifecycleAction = action
        await lifecycle.mutateAsync({
          campaignId: campaign.id,
          action: lifecycleAction,
        })
      }
      setConfirm({ action: null, campaign: null })
    } catch (err) {
      // oxlint-disable-next-line no-console -- surface unexpected mutation failures for forensics
      console.error('[campaigns] action failed', { action, campaignId: campaign.id, err })
      setErrorBanner(err instanceof Error ? err.message : `Failed to ${action} campaign`)
    }
  }

  function cancelConfirm() {
    if (lifecycle.isPending || del.isPending) return
    setConfirm({ action: null, campaign: null })
  }

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Campaigns</PageHeader>
        <EmptyState message="Select a project to view campaigns." />
      </div>
    )
  }

  const campaigns = (data?.campaigns as CampaignRow[] | undefined) ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader>Campaigns</PageHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Filter by campaign status"
            className="w-auto px-3 py-1.5 text-xs"
            value={status}
            onValueChange={(v) => updateParam('status', v)}
            options={[
              { value: '', label: 'All statuses' },
              { value: 'draft', label: 'Draft' },
              { value: 'running', label: 'Running' },
              { value: 'paused', label: 'Paused' },
              { value: 'completed', label: 'Completed' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
          <Select
            aria-label="Filter by campaign priority"
            className="w-auto px-3 py-1.5 text-xs"
            value={priorityRaw}
            onValueChange={(v) => updateParam('priority', v)}
            options={PRIORITY_FILTER_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          />
          <Select
            aria-label="Sort campaigns by"
            className="w-auto px-3 py-1.5 text-xs"
            value={sortParam}
            onValueChange={(v) => updateParam('sort', v)}
            options={SORT_FIELD_OPTIONS.map((opt) => ({
              value: opt.value,
              label: `Sort: ${opt.label}`,
            }))}
          />
          <button
            type="button"
            aria-label={`Toggle sort order (currently ${orderParam})`}
            className={buttonVariants('secondary', 'sm')}
            onClick={() => updateParam('order', orderParam === 'asc' ? 'desc' : 'asc')}
          >
            {orderParam === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
          <PermissionGuard permission={Permission.CAMPAIGN_CREATE}>
            <Link to="/campaigns/new" className={buttonVariants('primary', 'sm')}>
              New Campaign
            </Link>
          </PermissionGuard>
        </div>
      </div>

      {errorBanner && <ErrorBanner message={errorBanner} />}

      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading campaigns..." />
        ) : isError ? (
          // Surface the query error distinctly from the "no campaigns
          // exist yet" empty state. A bad deep link or transient API
          // failure now reads as the error it is, not a false empty
          // result that the operator might trust.
          <ErrorBanner
            message={error instanceof Error ? error.message : 'Failed to load campaigns'}
          />
        ) : !campaigns.length ? (
          <div className="space-y-3 rounded-md border border-surface-1 bg-surface-0/40 p-6 text-center">
            <p className="text-sm font-medium text-foreground">No campaigns yet</p>
            <p className="mx-auto max-w-prose text-xs text-muted-foreground">
              A campaign points attacks - dictionary, mask, or rules - at a hash list and hands the
              work to your agents. Create one to start cracking.
            </p>
            <PermissionGuard permission={Permission.CAMPAIGN_CREATE}>
              <Link to="/campaigns/new" className={buttonVariants('primary', 'sm')}>
                Create your first campaign
              </Link>
            </PermissionGuard>
          </div>
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Priority</Th>
                <Th>Progress</Th>
                <Th>Hash List</Th>
                <Th>Created</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {campaigns.map((campaign) => {
                const percentage = readCampaignPercentage(campaign.progress)
                return (
                  <TableRow key={campaign.id}>
                    <Td className="text-sm font-medium text-foreground">
                      <Link
                        to={`/campaigns/${campaign.id}`}
                        className="hover:text-primary hover:underline"
                      >
                        {campaign.name}
                      </Link>
                    </Td>
                    <Td>
                      <StatusBadge status={campaign.status} />
                    </Td>
                    <Td>
                      <PriorityBadge priority={campaign.priority} />
                    </Td>
                    <Td className="min-w-[120px]">
                      <ProgressBar
                        value={percentage}
                        size="thin"
                        ariaLabel={`${campaign.name} progress`}
                      />
                      <span className="mt-1 block font-mono text-xs text-muted-foreground tabular-nums">
                        {(percentage <= 1 ? percentage * 100 : percentage).toFixed(1)}%
                      </span>
                    </Td>
                    <Td className="font-mono text-xs text-muted-foreground">
                      #{campaign.hashListId}
                    </Td>
                    <Td className="text-xs text-muted-foreground">
                      {new Date(campaign.createdAt).toLocaleDateString()}
                    </Td>
                    <Td>
                      <PermissionGuard permission={Permission.CAMPAIGN_EDIT}>
                        <CampaignActionsMenu
                          status={campaign.status}
                          onAction={(action) => handleAction(campaign, action)}
                        />
                      </PermissionGuard>
                    </Td>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <ConfirmDialog
        open={confirm.action === 'start' && !!confirm.campaign}
        title="Start campaign?"
        message={
          confirm.campaign
            ? `"${confirm.campaign.name}" - Hash list #${confirm.campaign.hashListId}, priority ${confirm.campaign.priority}.`
            : ''
        }
        confirmLabel="Confirm Start"
        busy={lifecycle.isPending}
        onConfirm={confirmAction}
        onCancel={cancelConfirm}
      />

      <ConfirmDialog
        open={confirm.action === 'stop' && !!confirm.campaign}
        title="Stop campaign?"
        message="This will cancel all running tasks and reset the campaign to draft status. In-flight work cannot be resumed."
        confirmLabel="Confirm Stop"
        destructive
        busy={lifecycle.isPending}
        onConfirm={confirmAction}
        onCancel={cancelConfirm}
      />

      <ConfirmDialog
        open={confirm.action === 'delete' && !!confirm.campaign}
        title="Delete campaign?"
        message={
          confirm.campaign
            ? `Permanently remove "${confirm.campaign.name}" and its attacks. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        destructive
        busy={del.isPending}
        onConfirm={confirmAction}
        onCancel={cancelConfirm}
      />
    </div>
  )
}
