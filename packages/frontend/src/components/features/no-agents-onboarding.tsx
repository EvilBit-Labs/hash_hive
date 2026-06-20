import { ArrowRight, Server } from 'lucide-react'
import { Link } from 'react-router'

import { buildAgentEnrollCommand } from '../../lib/agent-enroll-command'
import { cn } from '../../lib/utils'
import { buttonVariants } from '../ui/button'
import { CopyableBlock } from '../ui/copyable-block'

interface NoAgentsOnboardingProps {
  /**
   * Origin used as the `--server` value in the enroll command. Pass
   * `window.location.origin` from the page-level consumer so the snippet
   * shows the operator's actual dashboard URL, not a placeholder.
   */
  readonly serverOrigin: string
}

/**
 * First-run hero for the dashboard. Mounts when the selected project
 * has zero registered agents — the wall-of-zeros bento is replaced
 * with a designed empty state that tells the operator what to do
 * next rather than what is not happening.
 *
 * The first real action is "mint an enrollment token", which only
 * happens on the agents page (where the full mint -> reveal flow
 * lives). So the primary affordance is a CTA that routes there; the
 * enroll command is shown beneath it as a labeled preview of what the
 * operator will run once they hold a token — not as the dominant
 * element, since with a placeholder token it can't be run as-is.
 *
 * Visual register matches the Cracked card's peach-drenched surface
 * so the eye lands on the same place it will land on once data
 * arrives; the bento swap doesn't move the operator's center of
 * attention.
 */
export function NoAgentsOnboarding({ serverOrigin }: NoAgentsOnboardingProps) {
  // Placeholder token — the operator mints a real one on the agents page
  // (the primary CTA below) and the reveal there inlines it for them.
  // Shared builder so the dashboard, agents reveal, and checklist never drift.
  const command = buildAgentEnrollCommand(serverOrigin)

  return (
    <section
      data-testid="dashboard-no-agents-onboarding"
      aria-labelledby="onboarding-title"
      className={cn(
        'relative overflow-hidden rounded-md border p-6 sm:p-8',
        // Matches StatCard primary surface so the onboarding hero
        // occupies the same visual slot the Cracked card will occupy
        // once data starts flowing. Avoids a vertigo swap.
        'bg-gradient-to-b from-[hsl(var(--ctp-peach)/0.16)] to-[hsl(var(--ctp-peach)/0.04)]',
        'border-[hsl(var(--ctp-peach)/0.35)]'
      )}
    >
      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-8">
        <div
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--ctp-peach)/0.18)] text-[hsl(var(--ctp-peach))]"
        >
          <Server className="h-6 w-6" />
        </div>

        <div className="min-w-0 flex-1 space-y-5">
          <div className="space-y-2">
            <h2
              id="onboarding-title"
              className="text-xl font-semibold tracking-tight text-balance text-[hsl(var(--ctp-peach))]"
            >
              Awaiting first agent
            </h2>
            <p className="max-w-prose text-sm text-foreground/80">
              Your dashboard fills in as soon as a hashcat worker connects to this project. Generate
              an enrollment token, then run the agent on a worker machine to register it.
            </p>
          </div>

          <Link to="/agents" className={cn(buttonVariants('primary'), 'gap-2')}>
            Generate enrollment token
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">You'll then run this on each worker:</p>
            <CopyableBlock value={command} ariaLabel="Copy command to clipboard" />
          </div>
        </div>
      </div>
    </section>
  )
}
