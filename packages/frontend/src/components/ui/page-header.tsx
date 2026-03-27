import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

interface PageHeaderProps extends HTMLAttributes<HTMLHeadingElement> {
  readonly children: React.ReactNode;
}

export function PageHeader({ children, className, ...props }: PageHeaderProps) {
  return (
    <h1 className={cn('text-xl font-semibold tracking-tight', className)} {...props}>
      {children}
    </h1>
  );
}
