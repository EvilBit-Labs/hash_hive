import type { CampaignTaskStats as CampaignTaskStatsShape } from '../../hooks/use-dashboard';
import { cn } from '../../lib/utils';

interface CampaignTaskStatsProps {
  stats: CampaignTaskStatsShape | null | undefined;
}

const TILES: Array<{
  key: keyof CampaignTaskStatsShape;
  label: string;
  toneClass: string;
}> = [
  { key: 'total', label: 'Total', toneClass: 'text-foreground' },
  { key: 'pending', label: 'Pending', toneClass: 'text-muted-foreground' },
  { key: 'running', label: 'Running', toneClass: 'text-info' },
  { key: 'completed', label: 'Completed', toneClass: 'text-success' },
  { key: 'failed', label: 'Failed', toneClass: 'text-destructive' },
];

export function CampaignTaskStats({ stats }: CampaignTaskStatsProps) {
  const safe: CampaignTaskStatsShape = stats ?? {
    total: 0,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {TILES.map((tile) => (
        <div
          key={tile.key}
          className="rounded-md border border-surface-0 bg-surface-0/40 p-3"
          data-testid={`task-stat-${tile.key}`}
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {tile.label}
          </p>
          <p className={cn('mt-1 font-mono text-lg font-bold tabular-nums', tile.toneClass)}>
            {safe[tile.key].toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  );
}
