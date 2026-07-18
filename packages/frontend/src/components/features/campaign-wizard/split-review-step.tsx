import type { HashTypeWire, SplitReviewGroups } from '@hashhive/shared'

import { hashTypeModeLabel } from '../../../lib/hash-type-mode-label'
import { Button } from '../../ui/button'
import { SegmentedControl, type SegmentedControlOption } from '../../ui/segmented-control'

interface SplitReviewStepProps {
  readonly reviewGroups: SplitReviewGroups
  readonly hashTypes: readonly HashTypeWire[]
  readonly assignments: Readonly<Record<number, number>>
  readonly onAssignmentChange: (subListId: number, mode: number) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly isConfirming: boolean
}

/**
 * Review step shown in place of the normal "Create Campaign" summary when
 * `POST /campaigns` comes back 200 with `SplitReviewGroups` instead of 201
 * with a created campaign (issue #202 SU3/SU6) — the target hash list mixed
 * more than one hash type, so the backend ran the split classifier instead
 * of creating a campaign.
 *
 * Three group kinds, each rendered differently:
 * - `confident`: the classifier already resolved a single mode. Read-only.
 * - `ambiguous`: multiple candidate modes tied; the operator must pick one
 *   via a `SegmentedControl` before Confirm is enabled.
 * - `unidentified`: no crackable type found. Informational only — no
 *   sub-campaign will run for these hashes.
 */
export function SplitReviewStep({
  reviewGroups,
  hashTypes,
  assignments,
  onAssignmentChange,
  onConfirm,
  onCancel,
  isConfirming,
}: SplitReviewStepProps) {
  const { confident, ambiguous, unidentified } = reviewGroups
  const allAssigned = ambiguous.every((group) => assignments[group.id] != null)
  const unidentifiedCount = unidentified.reduce((sum, group) => sum + group.itemCount, 0)

  return (
    <div className="space-y-4">
      <div
        className="rounded-md border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning"
        role="alert"
      >
        <p className="font-medium">This hash list mixes more than one hash type.</p>
        <p className="mt-1 text-warning/90">
          Resolve the groups below to split it into typed sub-campaigns. Each sub-campaign cracks
          one hash type.
        </p>
      </div>

      {confident.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Resolved ({confident.length})
          </h3>
          <ul className="space-y-2">
            {confident.map((group) => (
              <li
                key={group.id}
                className="flex items-center justify-between rounded-md border border-surface-0 bg-surface-0/40 px-4 py-3 text-sm"
              >
                <span className="tabular-nums">{group.itemCount.toLocaleString()} hashes</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {hashTypeModeLabel(group.mode, hashTypes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ambiguous.length > 0 && (
        <section className="space-y-3">
          <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Needs your input ({ambiguous.length})
          </h3>
          <ul className="space-y-3">
            {ambiguous.map((group) => {
              const options: SegmentedControlOption[] = group.candidateModes.map((mode) => ({
                value: String(mode),
                label: hashTypeModeLabel(mode, hashTypes),
              }))
              const selected = assignments[group.id]
              const value = selected != null ? String(selected) : ''

              return (
                <li
                  key={group.id}
                  className="space-y-2 rounded-md border border-surface-0 bg-surface-0/40 px-4 py-3"
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="tabular-nums">{group.itemCount.toLocaleString()} hashes</span>
                    {value === '' && (
                      <span className="text-xs font-medium text-warning">Pick a type</span>
                    )}
                  </div>
                  <SegmentedControl
                    aria-label={`Hash type for group of ${group.itemCount} hashes`}
                    value={value}
                    onChange={(v) => onAssignmentChange(group.id, Number(v))}
                    options={options}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {unidentified.length > 0 && (
        <section className="rounded-md border border-surface-0 bg-surface-0/40 px-4 py-3 text-sm text-muted-foreground">
          <p>
            {unidentifiedCount.toLocaleString()} hashes need a type. No sub-campaign will run for
            them.
          </p>
        </section>
      )}

      <div className="flex gap-2">
        <Button onClick={onConfirm} disabled={!allAssigned || isConfirming}>
          {isConfirming ? 'Creating...' : 'Confirm & Create'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={isConfirming}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
