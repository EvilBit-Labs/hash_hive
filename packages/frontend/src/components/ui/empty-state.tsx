import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

interface EmptyStateProps {
  readonly message: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export function EmptyState({ message, action, className }: EmptyStateProps) {
  if (action) {
    return (
      <div className={cn('space-y-3', className)}>
        <p className="text-sm text-muted-foreground">{message}</p>
        {action}
      </div>
    );
  }

  return <p className={cn('text-sm text-muted-foreground', className)}>{message}</p>;
}
