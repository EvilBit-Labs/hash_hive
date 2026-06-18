import { Check } from 'lucide-react'
import { Link } from 'react-router'

import { useDashboardStats } from '../../hooks/use-dashboard'
import { useHashLists, useRulelists, useWordlists } from '../../hooks/use-resources'
import { cn } from '../../lib/utils'

interface Step {
  readonly label: string
  readonly hint: string
  readonly href: string
  readonly done: boolean
}

/**
 * First-run checklist for the dashboard. Carries the operator through the
 * full arc once their first agent is connected: hash list -> wordlist /
 * rules -> campaign -> launch. Progress is derived entirely from live data
 * (no persisted "seen" flag, no localStorage), so it always reflects
 * reality and simply disappears once the arc is complete.
 *
 * Deliberately static — per `.impeccable.md` principle 1, motion is
 * reserved for genuine operator moments (a crack, an agent transition),
 * not chrome like a progress tracker. It renders only after the first
 * agent exists, so it never competes with the zero-agent hero (which is
 * the rich "register an agent" CTA).
 */
export function FirstRunChecklist() {
  const { data: stats } = useDashboardStats()
  const { data: hashLists } = useHashLists()
  const { data: wordlists } = useWordlists()
  const { data: rulelists } = useRulelists()

  // Wait for the gating signal (agent count) before deciding anything.
  if (!stats) return null

  const hasAgent = stats.agents.total > 0
  const hasHashList = (hashLists?.hashLists.length ?? 0) > 0
  const hasResource =
    (wordlists?.resources.length ?? 0) > 0 || (rulelists?.resources.length ?? 0) > 0
  const hasCampaign = stats.campaigns.total > 0
  const hasLaunched = stats.campaigns.running > 0 || stats.campaigns.completed > 0

  const steps: Step[] = [
    { label: 'Register an agent', hint: 'A worker connected', href: '/agents', done: hasAgent },
    {
      label: 'Add a hash list',
      hint: 'The hashes you want to crack',
      href: '/resources',
      done: hasHashList,
    },
    {
      label: 'Add a wordlist or rules',
      hint: 'What the agents try',
      href: '/resources',
      done: hasResource,
    },
    {
      label: 'Create a campaign',
      hint: 'Point attacks at your hashes',
      href: '/campaigns',
      done: hasCampaign,
    },
    { label: 'Launch it', hint: 'Put the rigs to work', href: '/campaigns', done: hasLaunched },
  ]

  const doneCount = steps.filter((s) => s.done).length
  // Show only after the first agent connects (the hero owns that step) and
  // only while the arc is incomplete.
  if (!hasAgent || doneCount === steps.length) return null

  const activeIndex = steps.findIndex((s) => !s.done)

  return (
    <section
      aria-labelledby="first-run-title"
      className="space-y-4 rounded-md border border-surface-1 bg-surface-0/40 p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="first-run-title" className="text-sm font-semibold tracking-tight">
          Finish setting up
        </h2>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {doneCount} of {steps.length} done
        </span>
      </div>

      <ol className="space-y-1">
        {steps.map((step, index) => {
          const isActive = index === activeIndex
          return (
            <li key={step.label}>
              <Link
                to={step.href}
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'flex items-center gap-3 rounded px-2 py-2 transition-colors',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  isActive
                    ? 'bg-[hsl(var(--ctp-peach)/0.1)] hover:bg-[hsl(var(--ctp-peach)/0.16)]'
                    : 'hover:bg-surface-1/60'
                )}
              >
                <StepMarker done={step.done} active={isActive} />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      'block text-sm',
                      step.done ? 'text-muted-foreground line-through' : 'text-foreground'
                    )}
                  >
                    {step.label}
                  </span>
                  <span className="block text-xs text-muted-foreground">{step.hint}</span>
                </span>
                {isActive && (
                  <span className="shrink-0 text-xs font-medium text-[hsl(var(--ctp-peach))]">
                    Start →
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function StepMarker({ done, active }: { done: boolean; active: boolean }) {
  // Status is never color-alone (principle 3): done = check glyph; active vs
  // pending is carried by the ring color AND the "Start →" label on the
  // active row (rendered by the caller), so the marker stays a bare ring.
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
        done
          ? 'border-success/40 bg-success/15 text-success'
          : active
            ? 'border-[hsl(var(--ctp-peach)/0.6)] bg-[hsl(var(--ctp-peach)/0.15)]'
            : 'border-surface-2'
      )}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : null}
    </span>
  )
}
