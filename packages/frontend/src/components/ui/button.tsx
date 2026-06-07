import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '../../lib/utils'

const BASE =
  'inline-flex items-center justify-center rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50'

// Variant affordance ladder. Every variant must read as a tappable
// control at rest, not as text. The previous `secondary` border used
// surface-0 (same color as the card behind it, invisible), and `ghost`
// had no decoration at all, which made both read like links. The
// rest states below carry the affordance; hover states bump the
// contrast further.
const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border border-surface-1 text-foreground hover:bg-surface-0/60 hover:border-surface-2',
  destructive: 'border border-destructive/30 text-destructive hover:bg-destructive/10',
  ghost:
    'border border-surface-0 bg-surface-0/50 text-foreground hover:bg-surface-0 hover:border-surface-1',
} as const

const SIZES = {
  sm: 'min-h-[36px] px-3 py-1.5 text-xs sm:min-h-[28px]',
  default: 'min-h-[44px] px-4 py-2 text-xs sm:min-h-[36px]',
} as const

export type ButtonVariant = keyof typeof VARIANTS
export type ButtonSize = keyof typeof SIZES

/** Returns class names for button styling - use on `<a>`, `<Link>`, or other non-button elements. */
export function buttonVariants(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'default'
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size])
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant
  readonly size?: ButtonSize
  readonly children: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'default',
  type = 'button',
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants(variant, size), className)} {...props}>
      {children}
    </button>
  )
}
