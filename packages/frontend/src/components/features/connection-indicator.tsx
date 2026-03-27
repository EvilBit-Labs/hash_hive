import { cn } from '../../lib/utils';

interface ConnectionIndicatorProps {
  connected: boolean;
}

export function ConnectionIndicator({ connected }: ConnectionIndicatorProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="relative flex h-2 w-2">
        {connected && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2 w-2 rounded-full',
            connected ? 'bg-success' : 'bg-destructive'
          )}
        />
      </span>
      <span className={cn(connected ? 'text-success' : 'text-destructive')}>
        {connected ? 'Live' : 'Reconnecting...'}
      </span>
    </div>
  );
}
