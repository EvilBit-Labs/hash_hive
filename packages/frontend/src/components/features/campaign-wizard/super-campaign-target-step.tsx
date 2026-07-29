import type { SuperCampaignFanoutResponse } from '@hashhive/shared'

import { useState } from 'react'
import { Link } from 'react-router'

import { cn } from '../../../lib/utils'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'

interface SuperOption {
  id: number
  name: string
}

interface SuperCampaignTargetStepProps {
  supers: readonly SuperOption[]
  submitting: boolean
  onCancel: () => void
  onSubmit: (data: {
    name: string
    superHashListId: number
    description?: string
    priority: number
  }) => void
}

/**
 * Campaign-create target step for a SuperHashlist (issue #101 U15). The
 * super-target path is single-step: targeting a super auto-confirms the
 * fan-out server-side (one typed sub-campaign per resolved leaf), so there is
 * no attacks/DAG step — the operator only picks a super, a name, and a
 * priority. Mirrors the hash-list target selection conceptually while using a
 * keyboard-navigable radio-style list (each super is a `role=radio` button) so
 * the choice is testable and survives grayscale / color-blind viewing.
 */
export function SuperCampaignTargetStep({
  supers,
  submitting,
  onCancel,
  onSubmit,
}: SuperCampaignTargetStepProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState(5)
  const [selectedSuperId, setSelectedSuperId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required.')
      return
    }
    if (selectedSuperId == null) {
      setError('Select a super hash list to target.')
      return
    }
    setError(null)
    onSubmit({
      name: trimmed,
      superHashListId: selectedSuperId,
      ...(description.trim() ? { description: description.trim() } : {}),
      priority,
    })
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="super-campaign-name" className="text-xs font-medium text-muted-foreground">
          Campaign Name
        </label>
        <Input
          id="super-campaign-name"
          className="mt-1.5"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div>
        <label
          htmlFor="super-campaign-description"
          className="text-xs font-medium text-muted-foreground"
        >
          Description
        </label>
        <textarea
          id="super-campaign-description"
          rows={2}
          className="mt-1.5 w-full rounded border border-surface-0 bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary/40"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="w-40">
        <label
          htmlFor="super-campaign-priority"
          className="text-xs font-medium text-muted-foreground"
        >
          Priority (1-10)
        </label>
        <Input
          id="super-campaign-priority"
          type="number"
          min={1}
          max={10}
          className="mt-1.5"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
      </div>

      <div>
        <p className="text-xs font-medium text-muted-foreground">Super Hash List</p>
        {supers.length === 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            No super hash lists in this project yet.{' '}
            <Link to="/super-hash-lists" className="text-primary hover:underline">
              Create one
            </Link>{' '}
            to target it here.
          </p>
        ) : (
          <div role="radiogroup" aria-label="Super hash list" className="mt-1.5 space-y-1.5">
            {supers.map((sup) => {
              const selected = sup.id === selectedSuperId
              return (
                <label
                  key={sup.id}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm transition-colors',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-surface-1 text-muted-foreground hover:bg-surface-0/60 hover:text-foreground'
                  )}
                >
                  <input
                    type="radio"
                    name="super-target"
                    className="accent-primary"
                    checked={selected}
                    onChange={() => setSelectedSuperId(sup.id)}
                  />
                  <span>{sup.name}</span>
                </label>
              )
            })}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="button" onClick={handleSubmit} disabled={submitting || supers.length === 0}>
          {submitting ? 'Creating...' : 'Create Super Campaign'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Success panel shown after a super campaign fans out. Lists the resulting
 * typed single-mode sub-campaigns (one per resolved leaf list) and links to
 * the parent campaign.
 */
export function SuperCampaignResultPanel({ result }: { result: SuperCampaignFanoutResponse }) {
  return (
    <div className="space-y-4">
      <div className="rounded border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
        Super campaign created. {result.subCampaigns.length} typed sub-campaign
        {result.subCampaigns.length === 1 ? '' : 's'} fanned out.
      </div>

      <div>
        <h3 className="text-sm font-semibold text-foreground">Sub-campaigns</h3>
        <ul className="mt-2 divide-y divide-surface-0/50 rounded border border-surface-0/50">
          {result.subCampaigns.map((sub) => (
            <li key={sub.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <Link
                to={`/campaigns/${sub.id}`}
                className="font-medium text-foreground hover:text-primary hover:underline"
              >
                Campaign #{sub.id}
              </Link>
              <span className="font-mono text-xs text-muted-foreground">
                mode {sub.mode} · hash list #{sub.hashListId}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <Link
        to={`/campaigns/${result.parentCampaignId}`}
        className="inline-block text-sm text-primary hover:underline"
      >
        View parent campaign #{result.parentCampaignId} &rarr;
      </Link>
    </div>
  )
}
