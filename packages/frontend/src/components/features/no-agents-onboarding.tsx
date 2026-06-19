import { Check, Copy, Server } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'

import { buildAgentEnrollCommand } from '../../lib/agent-enroll-command'
import { cn } from '../../lib/utils'

const COPIED_FLASH_MS = 1_500

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
 * Visual register matches the Cracked card's peach-drenched surface
 * so the eye lands on the same place it will land on once data
 * arrives; the bento swap doesn't move the operator's center of
 * attention.
 */
export function NoAgentsOnboarding({ serverOrigin }: NoAgentsOnboardingProps) {
  // Shared with the agents-page reveal and the first-run checklist so the
  // three never drift. Placeholder token — the operator mints a real one
  // on the agents page (linked below) and pastes it in.
  const command = buildAgentEnrollCommand(serverOrigin)

  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )

  const onCopy = useCallback(() => {
    // navigator.clipboard is undefined in non-secure contexts (plain
    // http, some embedded webviews). Reading `.writeText` would throw
    // a TypeError synchronously, which the `.catch` below cannot
    // catch. Short-circuit so the button click stays a no-op rather
    // than crashing the page; the snippet text is still selectable.
    if (typeof navigator === 'undefined' || !navigator.clipboard) return
    void navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        setCopyFailed(false)
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        timeoutRef.current = setTimeout(() => setCopied(false), COPIED_FLASH_MS)
      })
      .catch(() => {
        setCopyFailed(true)
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
            <p className="max-w-prose text-sm text-foreground/80">
              Your dashboard fills in as soon as a hashcat worker connects to this project. Generate
              an enrollment token, then run this on a worker machine to register it.
            </p>
          </div>

          <div>
            <div className="relative">
              <pre className="overflow-x-auto rounded border border-surface-1 bg-surface-0/70 p-4 pr-12 font-mono text-xs leading-relaxed text-foreground/90">
                <code>{command}</code>
              </pre>
              <button
                type="button"
                onClick={onCopy}
                aria-label={copied ? 'Command copied' : 'Copy command to clipboard'}
                className={cn(
                  'absolute top-2.5 right-2.5 inline-flex h-8 w-8 items-center justify-center rounded',
                  'border border-surface-1 bg-surface-0/95 transition-colors hover:bg-surface-1',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                )}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            </div>
            {copyFailed && (
              <p className="mt-1 text-xs text-warning">
                Copy failed - select the text and copy manually.
              </p>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Generate an enrollment token on the{' '}
            <Link
              to="/agents"
              className={cn(
                'rounded-sm text-[hsl(var(--ctp-peach))] underline-offset-2 hover:underline',
                'focus-visible:ring-2 focus-visible:ring-[hsl(var(--ctp-peach)/0.6)] focus-visible:outline-none'
              )}
            >
              agents page
            </Link>
            , then drop it into <code className="font-mono text-foreground/90">--token</code> above.
          </p>
        </div>
      </div>
    </section>
  )
}
