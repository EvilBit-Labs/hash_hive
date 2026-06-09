import { cn } from '../../lib/utils'

interface KbdProps {
  /** The shortcut character to display (e.g. `/`, `E`). Plain string only. */
  readonly children: string
  readonly className?: string
}

/**
 * Tiny `<kbd>` chip that surfaces a keyboard shortcut inline next to
 * the action it triggers. Operator-grade chrome: the shortcut char is
 * Space Mono; the surrounding chip is muted so it recedes until the
 * operator is ready to learn the shortcut.
 */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-sm',
        'border border-surface-1 bg-surface-0/40 px-1',
        'font-mono text-[10px] leading-none font-medium text-muted-foreground',
        className
      )}
    >
      {children}
    </kbd>
  )
}
