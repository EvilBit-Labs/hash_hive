import { ArrowRight, Server } from 'lucide-react'
import { Link } from 'react-router'

import { buildAgentEnrollCommand } from '../../lib/agent-enroll-command'
import { cn } from '../../lib/utils'
import { buttonVariants } from '../ui/button'
import { CopyableBlock } from '../ui/copyable-block'
import { OnboardingHero } from '../ui/onboarding-hero'

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
 */
export function NoAgentsOnboarding({ serverOrigin }: NoAgentsOnboardingProps) {
  // Placeholder token — the operator mints a real one on the agents page
  // (the primary CTA below) and the reveal there inlines it for them.
  // Shared builder so the dashboard, agents reveal, and checklist never drift.
  const command = buildAgentEnrollCommand(serverOrigin)

  return (
    <OnboardingHero
      testId="dashboard-no-agents-onboarding"
      titleId="onboarding-title"
      title="Awaiting first agent"
      icon={<Server className="h-6 w-6" />}
      description="Your dashboard fills in as soon as a hashcat worker connects to this project. Generate an enrollment token, then run the agent on a worker machine to register it."
    >
      <Link to="/agents" className={cn(buttonVariants('primary'), 'gap-2')}>
        Generate enrollment token
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">You'll then run this on each worker:</p>
        <CopyableBlock value={command} ariaLabel="Copy command to clipboard" />
      </div>
    </OnboardingHero>
  )
}
