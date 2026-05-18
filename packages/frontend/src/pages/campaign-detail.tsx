import { lazy, Suspense, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { CampaignAgentsSection } from '../components/features/campaign-agents-section';
import { CampaignTaskStats } from '../components/features/campaign-task-stats';
import { PermissionGuard } from '../components/features/permission-guard';
import { PriorityBadge } from '../components/features/priority-badge';
import { StatusBadge } from '../components/features/status-badge';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { EmptyState } from '../components/ui/empty-state';
import { ErrorBanner } from '../components/ui/error-banner';
import { PageHeader } from '../components/ui/page-header';
import { ProgressBar } from '../components/ui/progress-bar';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useCampaignDelete, useCampaignLifecycle } from '../hooks/use-campaigns';
import { useCampaignDetail } from '../hooks/use-dashboard';
import { computeEta } from '../lib/campaign-eta';
import { readCampaignPercentage } from '../lib/campaign-progress';
import { Permission } from '../lib/permissions';

// Lazy-load the DAG view so reactflow's bundle weight is only paid when
// the detail page is actually visited.
const CampaignDagView = lazy(() =>
  import('../components/features/campaign-dag-view').then((m) => ({
    default: m.CampaignDagView,
  }))
);

type ConfirmAction = 'stop' | 'delete' | null;

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const campaignId = Number(id);
  const navigate = useNavigate();

  const { data, isLoading, isError, error } = useCampaignDetail(campaignId);
  const lifecycle = useCampaignLifecycle();
  const del = useCampaignDelete();

  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  function handleStart() {
    setErrorBanner(null);
    // The detail page already shows full campaign context, so Start does
    // not need an interstitial confirmation modal.
    lifecycle.mutate(
      { campaignId, action: 'start' },
      {
        onError: (err) => {
          // biome-ignore lint/suspicious/noConsole: surface unexpected mutation failures for forensics
          console.error('[campaign-detail] start failed', { campaignId, err });
          setErrorBanner(err instanceof Error ? err.message : 'Failed to start campaign');
        },
      }
    );
  }

  function handlePause() {
    setErrorBanner(null);
    lifecycle.mutate(
      { campaignId, action: 'pause' },
      {
        onError: (err) => {
          // biome-ignore lint/suspicious/noConsole: surface unexpected mutation failures for forensics
          console.error('[campaign-detail] pause failed', { campaignId, err });
          setErrorBanner(err instanceof Error ? err.message : 'Failed to pause campaign');
        },
      }
    );
  }

  async function confirmStop() {
    try {
      await lifecycle.mutateAsync({ campaignId, action: 'stop' });
      setConfirm(null);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: surface unexpected mutation failures for forensics
      console.error('[campaign-detail] stop failed', { campaignId, err });
      setErrorBanner(err instanceof Error ? err.message : 'Failed to stop campaign');
    }
  }

  async function confirmDelete() {
    try {
      await del.mutateAsync({ campaignId });
      setConfirm(null);
      navigate('/campaigns');
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: surface unexpected mutation failures for forensics
      console.error('[campaign-detail] delete failed', { campaignId, err });
      setErrorBanner(err instanceof Error ? err.message : 'Failed to delete campaign');
    }
  }

  function cancelConfirm() {
    if (lifecycle.isPending || del.isPending) return;
    setConfirm(null);
  }

  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <ErrorBanner message="Invalid campaign id in URL." />
      </div>
    );
  }

  if (isLoading) {
    return <EmptyState message="Loading campaign..." />;
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <ErrorBanner message={error instanceof Error ? error.message : 'Failed to load campaign'} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>
        <EmptyState message="Campaign not found." />
      </div>
    );
  }

  const { campaign, attacks, taskStats, activeAgents } = data;
  const percentage = readCampaignPercentage(campaign.progress);
  const eta = computeEta(taskStats, activeAgents);

  const canStart = campaign.status === 'draft' || campaign.status === 'paused';
  const canPause = campaign.status === 'running';
  const canStop = campaign.status === 'running' || campaign.status === 'paused';
  const canDelete = campaign.status === 'draft';

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <TextLink to="/campaigns" back>
          Back to campaigns
        </TextLink>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <PageHeader>{campaign.name}</PageHeader>
            <StatusBadge status={campaign.status} />
            <PriorityBadge priority={campaign.priority} />
          </div>
          <PermissionGuard permission={Permission.CAMPAIGN_EDIT}>
            <div className="flex flex-wrap gap-2">
              {canStart && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleStart}
                  disabled={lifecycle.isPending}
                >
                  {campaign.status === 'paused' ? 'Resume' : 'Start'}
                </Button>
              )}
              {canPause && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePause}
                  disabled={lifecycle.isPending}
                >
                  Pause
                </Button>
              )}
              {canStop && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setConfirm('stop')}
                  disabled={lifecycle.isPending}
                >
                  Stop
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setConfirm('delete')}
                  disabled={del.isPending}
                >
                  Delete
                </Button>
              )}
            </div>
          </PermissionGuard>
        </div>

        {campaign.description && (
          <p className="text-sm text-muted-foreground">{campaign.description}</p>
        )}
      </div>

      {errorBanner && <ErrorBanner message={errorBanner} />}

      <section aria-labelledby="progress-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 id="progress-heading" className="text-sm font-medium">
            Progress
          </h3>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            ETA: <span data-testid="campaign-eta">{eta}</span>
          </p>
        </div>
        <ProgressBar
          value={percentage}
          ariaLabel="Campaign overall progress"
          label={`${(percentage <= 1 ? percentage * 100 : percentage).toFixed(1)}% complete`}
        />
        <CampaignTaskStats stats={taskStats} />
      </section>

      <section aria-labelledby="active-agents-heading" className="space-y-3">
        <h3 id="active-agents-heading" className="text-sm font-medium">
          Active agents
        </h3>
        <CampaignAgentsSection agents={activeAgents} />
      </section>

      <section aria-labelledby="dag-heading" className="space-y-3">
        <h3 id="dag-heading" className="text-sm font-medium">
          Attack dependencies
        </h3>
        <Suspense fallback={<EmptyState message="Loading graph..." />}>
          <CampaignDagView attacks={attacks} />
        </Suspense>
      </section>

      <section aria-labelledby="attacks-heading" className="space-y-3">
        <h3 id="attacks-heading" className="text-sm font-medium">
          Attacks
        </h3>
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
      </section>

      <div className="space-y-1 border-t border-surface-0/50 pt-4 text-xs text-muted-foreground">
        <p>Created {new Date(campaign.createdAt).toLocaleString()}</p>
        {campaign.startedAt && <p>Started {new Date(campaign.startedAt).toLocaleString()}</p>}
        {campaign.completedAt && <p>Completed {new Date(campaign.completedAt).toLocaleString()}</p>}
      </div>

      <ConfirmDialog
        open={confirm === 'stop'}
        title="Stop campaign?"
        message="This will cancel all running tasks and reset the campaign to draft status. In-flight work cannot be resumed."
        confirmLabel="Confirm Stop"
        destructive
        busy={lifecycle.isPending}
        onConfirm={confirmStop}
        onCancel={cancelConfirm}
      />

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete campaign?"
        message={`Permanently remove "${campaign.name}" and its attacks. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        busy={del.isPending}
        onConfirm={confirmDelete}
        onCancel={cancelConfirm}
      />
    </div>
  );
}
