import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

interface EmptyStateProps {
  readonly message: string
  readonly action?: ReactNode
  readonly className?: string
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  if (action) {
    return (
      <div className={cn('space-y-3', className)}>
        <p className="text-muted-foreground text-sm">{message}</p>
        {action}
      </div>
    )
  }

  return <p className={cn('text-muted-foreground text-sm', className)}>{message}</p>
}
