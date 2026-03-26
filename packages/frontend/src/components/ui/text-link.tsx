import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';

interface TextLinkProps extends Omit<HTMLAttributes<HTMLAnchorElement>, 'children'> {
  readonly to: string;
  readonly children: ReactNode;
}

export function TextLink({ to, children, className, ...props }: TextLinkProps) {
  return (
    <Link
      to={to}
      className={cn('text-xs font-medium text-primary hover:text-primary/80', className)}
      {...props}
    >
      {children}
    </Link>
  );
}
