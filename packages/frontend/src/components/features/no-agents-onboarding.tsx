import { Check, Copy, Server } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { cn } from '../../lib/utils'

const COPIED_FLASH_MS = 1_500

interface NoAgentsOnboardingProps {
  /**
   * Origin used as the `--server` value in the install command. Pass
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
 * Visual register matches the Cracked card's peach-drenched surface
 * so the eye lands on the same place it will land on once data
 * arrives; the bento swap doesn't move the operator's center of
 * attention.
 */
export function NoAgentsOnboarding({ serverOrigin }: NoAgentsOnboardingProps) {
  const command = [
    `curl -fsSL ${serverOrigin}/install.sh \\`,
    `  | HASHHIVE_SERVER=${serverOrigin} \\`,
    `    HASHHIVE_TOKEN=<AGENT_TOKEN> sh`,
  ].join('\n')

  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const onCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS)
      })
      .catch(() => {
        // Clipboard API failure is rare (Safari over plain http, locked
        // permissions). The command is still visible and selectable,
        // so we silently fail the copy rather than surface a toast for
        // a non-blocking action.
      })
  }, [command])

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
            <p className="text-foreground/80 max-w-prose text-sm">
              Your dashboard fills in as soon as a hashcat worker connects to this project. Run the
              command below on a worker machine to register it.
            </p>
          </div>

          <div className="relative">
            <pre className="bg-surface-0/70 border-surface-1 text-foreground/90 overflow-x-auto rounded border p-4 pr-12 font-mono text-xs leading-relaxed">
              <code>{command}</code>
            </pre>
            <button
              type="button"
              onClick={onCopy}
              aria-label={copied ? 'Command copied' : 'Copy command to clipboard'}
              className={cn(
                'absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded',
                'border-surface-1 bg-surface-0/95 hover:bg-surface-1 border transition-colors',
                'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
              )}
            >
              {copied ? (
                <Check className="text-success h-3.5 w-3.5" />
              ) : (
                <Copy className="text-muted-foreground h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <p className="text-muted-foreground text-xs">
            Replace <code className="text-foreground/90 font-mono">{'<AGENT_TOKEN>'}</code> with a
            token from the agents page.{' '}
            <Link
              to="/agents"
              className="text-[hsl(var(--ctp-peach))] underline-offset-2 hover:underline"
            >
              Manage agents
            </Link>
          </p>
        </div>
      </div>
    </section>
  )
}
