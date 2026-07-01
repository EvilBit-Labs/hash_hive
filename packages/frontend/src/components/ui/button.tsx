import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../../lib/utils'

// Variant affordance ladder. Every variant reads as a tappable control
// at rest; hover bumps the contrast further. Ghost has no rest-state
// background to avoid stacking against hovered table rows (the row's
// surface-0/20 hover tint would double under the button); the border
// alone carries its affordance.
const buttonStyles = cva(
  'inline-flex items-center justify-center rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary:
          'border border-surface-1 text-foreground hover:bg-surface-0/60 hover:border-surface-2',
        destructive: 'border border-destructive/30 text-destructive hover:bg-destructive/10',
        ghost:
          'border border-surface-1/60 text-foreground hover:bg-surface-0/60 hover:border-surface-1',
      },
      size: {
        sm: 'min-h-[36px] px-3 py-1.5 text-xs sm:min-h-[28px]',
        default: 'min-h-[44px] px-4 py-2 text-xs sm:min-h-[36px]',
      },
    },
    defaultVariants: { variant: 'primary', size: 'default' },
  }
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonStyles>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonStyles>['size']>

/**
 * Returns class names for button styling - use on `<a>`, `<Link>`, or other
 * non-button elements. The positional signature is preserved so existing
 * callsites (`buttonVariants('secondary', 'sm')`) keep working.
 */
export function buttonVariants(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'default'
): string {
  return buttonStyles({ variant, size })
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
    <button type={type} className={cn(buttonStyles({ variant, size }), className)} {...props}>
      {children}
    </button>
  )
}
