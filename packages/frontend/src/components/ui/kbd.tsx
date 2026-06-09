import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

interface KbdProps {
  readonly children: ReactNode
  readonly className?: string
}

/**
 * Tiny `<kbd>` chip that surfaces a keyboard shortcut inline next to
 * the action it triggers. Reads as the operator-grade pit-wall HUD
 * pattern .impeccable.md asks for in principle 4 ("keyboard is a
 * first-class peer of mouse"). The shortcut character itself is
 * Space Mono; the chrome around it is muted so the chip recedes
 * until the operator is ready to learn the shortcut.
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
