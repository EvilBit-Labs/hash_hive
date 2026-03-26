import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { PermissionGuard } from '../components/features/permission-guard';
import { StatusBadge } from '../components/features/status-badge';
import { useCampaignLifecycle } from '../hooks/use-campaigns';
import { api } from '../lib/api';
import { Permission } from '../lib/permissions';

interface Campaign {
  id: number;
  name: string;
  description: string | null;
  status: string;
  projectId: number;
  hashListId: number;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface Attack {
  id: number;
  campaignId: number;
  mode: number;
  status: string;
  wordlistId: number | null;
  rulelistId: number | null;
  masklistId: number | null;
  dependencies: number[] | null;
}

function useCampaignDetail(campaignId: number) {
  return useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () =>
      api.get<{ campaign: Campaign; attacks: Attack[] }>(`/dashboard/campaigns/${campaignId}`),
    enabled: campaignId > 0,
  });
}

const LIFECYCLE_ACTIONS: Record<
  string,
  Array<{ action: 'start' | 'pause' | 'stop' | 'cancel'; label: string; variant: string }>
> = {
  draft: [{ action: 'start', label: 'Start', variant: 'primary' }],
  running: [
    { action: 'pause', label: 'Pause', variant: 'secondary' },
    { action: 'stop', label: 'Stop', variant: 'secondary' },
    { action: 'cancel', label: 'Cancel', variant: 'destructive' },
  ],
  paused: [
    { action: 'start', label: 'Resume', variant: 'primary' },
    { action: 'stop', label: 'Stop', variant: 'secondary' },
    { action: 'cancel', label: 'Cancel', variant: 'destructive' },
  ],
};

function actionButtonClass(variant: string): string {
  if (variant === 'primary') {
    return 'rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
  }
  if (variant === 'destructive') {
    return 'rounded border border-destructive/30 px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50';
  }
  return 'rounded border border-surface-0 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground disabled:opacity-50';
}

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const { data, isLoading } = useCampaignDetail(campaignId);
  const lifecycle = useCampaignLifecycle(campaignId);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading campaign\u2026</p>;
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Link to="/campaigns" className="text-xs font-medium text-primary hover:text-primary/80">
          \u2190 Back to campaigns
        </Link>
        <p className="text-sm text-muted-foreground">Campaign not found.</p>
      </div>
    );
  }

  const { campaign, attacks } = data;
  const actions = LIFECYCLE_ACTIONS[campaign.status] ?? [];

  return (
    <div className="space-y-6">
      <Link to="/campaigns" className="text-xs font-medium text-primary hover:text-primary/80">
        \u2190 Back to campaigns
      </Link>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{campaign.name}</h2>
          <StatusBadge status={campaign.status} />
        </div>
        <PermissionGuard permission={Permission.CAMPAIGN_EDIT}>
          <div className="flex gap-2">
            {actions.map(({ action, label, variant }) => (
              <button
                key={action}
                type="button"
                onClick={() => lifecycle.mutate(action)}
                disabled={lifecycle.isPending}
                className={actionButtonClass(variant)}
              >
                {label}
              </button>
            ))}
          </div>
        </PermissionGuard>
      </div>

      {campaign.description && (
        <p className="text-sm text-muted-foreground">{campaign.description}</p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Priority
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{campaign.priority}</p>
        </div>
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Attacks
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">{attacks.length}</p>
        </div>
        <div className="rounded-md border border-surface-0 bg-surface-0/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Hash List
          </p>
          <p className="mt-2 font-mono text-2xl font-bold tabular-nums">#{campaign.hashListId}</p>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Attacks</h3>
        {attacks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attacks configured.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-surface-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-surface-0 bg-surface-0/30">
                <tr>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    ID
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Mode
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Status
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Wordlist
                  </th>
                  <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Dependencies
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-0/50">
                {attacks.map((attack) => (
                  <tr key={attack.id} className="transition-colors hover:bg-surface-0/20">
                    <td className="px-4 py-2.5 font-mono text-xs">{attack.id}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-medium">{attack.mode}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={attack.status} />
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {attack.wordlistId ? `#${attack.wordlistId}` : '\u2014'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {attack.dependencies?.length ? attack.dependencies.join(', ') : 'None'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p>Created {new Date(campaign.createdAt).toLocaleString()}</p>
        {campaign.startedAt && <p>Started {new Date(campaign.startedAt).toLocaleString()}</p>}
        {campaign.completedAt && <p>Completed {new Date(campaign.completedAt).toLocaleString()}</p>}
      </div>
    </div>
  );
}
