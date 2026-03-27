import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/utils';

const BASE =
  'inline-flex items-center justify-center rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50';

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
  secondary:
    'border border-surface-0 text-muted-foreground hover:bg-surface-0/60 hover:text-foreground',
  destructive: 'border border-destructive/30 text-destructive hover:bg-destructive/10',
  ghost: 'text-muted-foreground hover:bg-surface-0/60 hover:text-foreground',
} as const;

const SIZES = {
  sm: 'min-h-[36px] px-3 py-1.5 text-xs sm:min-h-0',
  default: 'min-h-[44px] px-4 py-2 text-xs sm:min-h-[36px]',
} as const;

export type ButtonVariant = keyof typeof VARIANTS;
export type ButtonSize = keyof typeof SIZES;

/** Returns class names for button styling - use on `<a>`, `<Link>`, or other non-button elements. */
export function buttonVariants(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'default'
): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly children: ReactNode;
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
  );
}
