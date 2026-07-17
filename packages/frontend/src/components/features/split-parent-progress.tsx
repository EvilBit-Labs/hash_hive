import type { SubCampaignProgress } from '@hashhive/shared'

import { AlertTriangle } from 'lucide-react'

import { cn } from '../../lib/utils'
import { ProgressBar } from '../ui/progress-bar'
import { StatusBadge } from './status-badge'

interface SubCampaignProgressSummaryProps {
  readonly progress: SubCampaignProgress
  readonly className?: string
}

/**
 * Aggregated progress summary for a split-parent hash list (issue #202
 * SU5/SU6). A split parent has no attacks or tasks of its own — every
 * sub-campaign targets one resolved hash type — so this reads the
 * pre-aggregated `subCampaignProgress` payload the detail route computes
 * on read (`getHashListSplitProgress`, combining each sub-campaign's own
 * `progress` jsonb) instead of a single campaign's progress.
 *
 * Renders nothing when `subCampaignProgress` is absent — the caller only
 * mounts this for a split parent, never for a normal (never-split) list.
 */
export function SubCampaignProgressSummary({
  progress,
  className,
}: SubCampaignProgressSummaryProps) {
  const {
    subCampaignCount,
    completedSubCampaignCount,
    done,
    totalTasks,
    completedTasks,
    tasksFailed,
    overallProgress,
    hashProgress,
  } = progress

  return (
    <div
      className={cn('space-y-3 rounded-md border border-surface-0 bg-surface-0/40 p-4', className)}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
          Sub-Campaign Progress
        </h3>
        <StatusBadge status={done ? 'completed' : 'running'} />
      </div>

      <ProgressBar
        value={overallProgress}
        ariaLabel="Overall sub-campaign progress"
        label={`${(overallProgress * 100).toFixed(1)}% complete`}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sub-Campaigns" value={`${completedSubCampaignCount}/${subCampaignCount}`} />
        <Stat label="Tasks" value={`${completedTasks}/${totalTasks}`} />
        {tasksFailed > 0 && (
          <Stat label="Failed" value={tasksFailed.toLocaleString()} className="text-destructive" />
        )}
        {hashProgress && (
          <Stat
            label="Hashes Cracked"
            value={`${hashProgress.cracked.toLocaleString()}/${hashProgress.total.toLocaleString()}`}
          />
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('font-mono text-sm font-medium tabular-nums', className)}>{value}</p>
    </div>
  )
}

interface NeedsTypeNoticeProps {
  readonly count: number
  readonly className?: string
}

/**
 * Surfaces `HashListDetailWire.needsTypeCount` for a split parent (issue
 * #202 SU5/SU6) — hash-item entries sitting in children whose type is
 * still unresolved, so no sub-campaign targets them yet.
 *
 * Deliberately a SEPARATE section from `SubCampaignProgressSummary`'s
 * `done` state, not folded into it: a split parent whose every
 * mode-bearing sub-campaign has completed can still have needs-type
 * children waiting on the operator, and "done" must not absorb that into
 * a single, contradictory status. Renders nothing when `count` is 0 (or
 * the field is absent — the caller passes 0 in that case).
 */
export function NeedsTypeNotice({ count, className }: NeedsTypeNoticeProps) {
  if (count <= 0) return null

  return (
    <div
      className={cn(
        'flex gap-3 rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning',
        className
      )}
      role="alert"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        {count.toLocaleString()} {count === 1 ? 'hash' : 'hashes'} still need a type before they can
        crack. Resolve them from the hash list and start a new campaign to include them.
      </p>
    </div>
  )
}
