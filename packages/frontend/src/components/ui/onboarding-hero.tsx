import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

interface OnboardingHeroProps {
  /** id for the heading, wired to the section's aria-labelledby. */
  readonly titleId: string
  readonly title: string
  readonly description: ReactNode
  /** Optional peach-tinted icon badge (e.g. a Server glyph). */
  readonly icon?: ReactNode
  readonly testId?: string
  /** CTA / command preview / mint flow — stacked under the description. */
  readonly children?: ReactNode
}

/**
 * The peach-drenched first-run hero surface, shared by the dashboard
 * "Awaiting first agent" state and the agents-page "No agents yet" state
 * so the two rhyme and can't drift. Matches the StatCard primary surface
 * so the bento swap doesn't move the operator's center of attention once
 * data arrives. Owns only the surface + header; callers supply the action.
 */
export function OnboardingHero({
  titleId,
  title,
  description,
  icon,
  testId,
  children,
}: OnboardingHeroProps) {
  return (
    <section
      data-testid={testId}
      aria-labelledby={titleId}
      className={cn(
        'relative overflow-hidden rounded-md border p-6 sm:p-8',
        'bg-gradient-to-b from-[hsl(var(--ctp-peach)/0.16)] to-[hsl(var(--ctp-peach)/0.04)]',
        'border-[hsl(var(--ctp-peach)/0.35)]'
      )}
    >
      <div className={cn(icon && 'flex flex-col gap-6 md:flex-row md:items-start md:gap-8')}>
        {icon && (
          <div
            aria-hidden="true"
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-[hsl(var(--ctp-peach)/0.18)] text-[hsl(var(--ctp-peach))]"
          >
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1 space-y-5">
          <div className="space-y-2">
            <h2
              id={titleId}
              className="text-xl font-semibold tracking-tight text-balance text-[hsl(var(--ctp-peach))]"
            >
              {title}
            </h2>
            <p className="max-w-prose text-sm text-foreground/80">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </section>
  )
}
