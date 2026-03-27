import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { PermissionGuard } from '../components/features/permission-guard';
import { StatusBadge } from '../components/features/status-badge';
import { Button } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { ErrorBanner } from '../components/ui/error-banner';
import { PageHeader } from '../components/ui/page-header';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useCampaignLifecycle } from '../hooks/use-campaigns';
import { api } from '../lib/api';
import { Permission } from '../lib/permissions';

interface HashProgress {
  total: number;
  cracked: number;
  remaining: number;
  percentage: number;
}

interface CampaignProgress {
  totalTasks?: number;
  completedTasks?: number;
  overallProgress?: number;
  hashProgress?: HashProgress;
}

interface Campaign {
  id: number;
  name: string;
  description: string | null;
  status: string;
  projectId: number;
  hashListId: number;
  priority: number;
  progress: CampaignProgress | null;
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

type LifecycleAction = 'start' | 'pause' | 'stop' | 'cancel';
type ButtonVariant = 'primary' | 'secondary' | 'destructive';

const LIFECYCLE_ACTIONS: Record<
  string,
  Array<{ action: LifecycleAction; label: string; variant: ButtonVariant }>
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

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const { data, isLoading, isError, error } = useCampaignDetail(campaignId);
  const lifecycle = useCampaignLifecycle(campaignId);

  if (isLoading) {
    return <EmptyState message="Loading campaign..." />;
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns">&larr; Back to campaigns</TextLink>
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load campaign'} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns">← Back to campaigns</TextLink>
        <EmptyState message="Campaign not found." />
      </div>
    );
  }

  const { campaign, attacks } = data;
  const actions = LIFECYCLE_ACTIONS[campaign.status] ?? [];

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <TextLink to="/campaigns">← Back to campaigns</TextLink>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <PageHeader>{campaign.name}</PageHeader>
            <StatusBadge status={campaign.status} />
          </div>
          <PermissionGuard permission={Permission.CAMPAIGN_EDIT}>
            <div className="flex gap-2">
              {actions.map(({ action, label, variant }) => (
                <Button
                  key={action}
                  variant={variant}
                  size="sm"
                  onClick={() => lifecycle.mutate(action)}
                  disabled={lifecycle.isPending}
                >
                  {label}
                </Button>
              ))}
            </div>
          </PermissionGuard>
        </div>

        {campaign.description && (
          <p className="text-sm text-muted-foreground">{campaign.description}</p>
        )}
      </div>

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

      {/* Hash-based progress section */}
      {campaign.progress?.hashProgress && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Crack Progress</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-md border border-surface-0 bg-surface-0/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Cracked
              </p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums text-success">
                {campaign.progress.hashProgress.cracked.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border border-surface-0 bg-surface-0/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Remaining
              </p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums">
                {campaign.progress.hashProgress.remaining.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border border-surface-0 bg-surface-0/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Total
              </p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums">
                {campaign.progress.hashProgress.total.toLocaleString()}
              </p>
            </div>
            <div className="rounded-md border border-surface-0 bg-surface-0/40 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Progress
              </p>
              <p className="mt-1 font-mono text-lg font-bold tabular-nums">
                {(campaign.progress.hashProgress.percentage * 100).toFixed(1)}%
              </p>
            </div>
          </div>
          <div className="h-2 w-full rounded-full bg-surface-1">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: `${Math.min(campaign.progress.hashProgress.percentage * 100, 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-medium">Attacks</h3>
        {attacks.length === 0 ? (
          <EmptyState message="No attacks configured." />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>ID</Th>
                <Th>Mode</Th>
                <Th>Status</Th>
                <Th>Wordlist</Th>
                <Th>Dependencies</Th>
              </tr>
            </TableHead>
            <TableBody>
              {attacks.map((attack) => (
                <TableRow key={attack.id}>
                  <Td className="font-mono text-xs">{attack.id}</Td>
                  <Td className="font-mono text-xs font-medium">{attack.mode}</Td>
                  <Td>
                    <StatusBadge status={attack.status} />
                  </Td>
                  <Td className="text-xs text-muted-foreground">
                    {attack.wordlistId ? `#${attack.wordlistId}` : '-'}
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">
                    {attack.dependencies?.length ? attack.dependencies.join(', ') : 'None'}
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="border-t border-surface-0/50 pt-4 space-y-1 text-xs text-muted-foreground">
        <p>Created {new Date(campaign.createdAt).toLocaleString()}</p>
        {campaign.startedAt && <p>Started {new Date(campaign.startedAt).toLocaleString()}</p>}
        {campaign.completedAt && <p>Completed {new Date(campaign.completedAt).toLocaleString()}</p>}
      </div>
    </div>
  );
}
