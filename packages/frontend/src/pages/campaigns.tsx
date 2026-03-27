import { useState } from 'react';
import { Link } from 'react-router';
import { PermissionGuard } from '../components/features/permission-guard';
import { StatusBadge } from '../components/features/status-badge';
import { buttonVariants } from '../components/ui/button';
import { EmptyState } from '../components/ui/empty-state';
import { PageHeader } from '../components/ui/page-header';
import { Select } from '../components/ui/select';
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table';
import { TextLink } from '../components/ui/text-link';
import { useCampaigns } from '../hooks/use-dashboard';
import { Permission } from '../lib/permissions';
import { useUiStore } from '../stores/ui';

export function CampaignsPage() {
  const { selectedProjectId } = useUiStore();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading } = useCampaigns(statusFilter ? { status: statusFilter } : undefined);

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Campaigns</PageHeader>
        <EmptyState message="Select a project to view campaigns." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader>Campaigns</PageHeader>
        <div className="flex gap-2">
          <Select
            aria-label="Filter by campaign status"
            className="w-auto px-3 py-1.5 text-xs"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="running">Running</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </Select>
          <PermissionGuard permission={Permission.CAMPAIGN_CREATE}>
            <Link to="/campaigns/new" className={buttonVariants('primary', 'sm')}>
              New Campaign
            </Link>
          </PermissionGuard>
        </div>
      </div>

      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading campaigns..." />
        ) : !data?.campaigns.length ? (
          <EmptyState message="No campaigns found." />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Priority</Th>
                <Th>Created</Th>
                <Th>Actions</Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.campaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <Td className="text-sm font-medium text-foreground">{campaign.name}</Td>
                  <Td>
                    <StatusBadge status={campaign.status} />
                  </Td>
                  <Td className="font-mono text-xs text-muted-foreground">{campaign.priority}</Td>
                  <Td className="text-xs text-muted-foreground">
                    {new Date(campaign.createdAt).toLocaleDateString()}
                  </Td>
                  <Td>
                    <TextLink to={`/campaigns/${campaign.id}`}>Details</TextLink>
                  </Td>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
