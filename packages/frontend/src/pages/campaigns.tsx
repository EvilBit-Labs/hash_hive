import { useState } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../components/features/status-badge';
import { useCampaigns } from '../hooks/use-dashboard';
import { useUiStore } from '../stores/ui';

export function CampaignsPage() {
  const { selectedProjectId } = useUiStore();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading } = useCampaigns(statusFilter ? { status: statusFilter } : undefined);

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Campaigns</h2>
        <p className="text-sm text-muted-foreground">Select a project to view campaigns.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Campaigns</h2>
        <div className="flex gap-2">
          <select
            className="rounded border border-surface-0 bg-background px-3 py-1.5 text-xs text-foreground"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="running">Running</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <Link
            to="/campaigns/new"
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            New Campaign
          </Link>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading campaigns\u2026</p>
      ) : !data?.campaigns.length ? (
        <p className="text-sm text-muted-foreground">No campaigns found.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-surface-0">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-surface-0 bg-surface-0/30">
              <tr>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Name
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Priority
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Created
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-0/50">
              {data.campaigns.map((campaign) => (
                <tr key={campaign.id} className="transition-colors hover:bg-surface-0/20">
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">
                    {campaign.name}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={campaign.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {campaign.priority}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(campaign.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/campaigns/${campaign.id}`}
                      className="text-xs font-medium text-primary hover:text-primary/80"
                    >
                      Details
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
