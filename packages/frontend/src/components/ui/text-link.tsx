import { ArrowLeft } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../../lib/utils';

interface TextLinkProps extends Omit<HTMLAttributes<HTMLAnchorElement>, 'children'> {
  readonly to: string;
  readonly children: ReactNode;
  /** Prepend an arrow-left icon for "back" navigation links. */
  readonly back?: boolean;
}

export function TextLink({ to, children, className, back, ...props }: TextLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80',
        className
      )}
      {...props}
    >
      {back && <ArrowLeft className="h-3 w-3" aria-hidden="true" />}
      {children}
    </Link>
  );
}
