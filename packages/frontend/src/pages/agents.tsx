import { useState } from 'react';
import { Link } from 'react-router';
import { StatusBadge } from '../components/features/status-badge';
import { useAgents } from '../hooks/use-dashboard';
import { useUiStore } from '../stores/ui';

export function AgentsPage() {
  const { selectedProjectId } = useUiStore();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const { data, isLoading } = useAgents(statusFilter ? { status: statusFilter } : undefined);

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Agents</h2>
        <p className="text-sm text-muted-foreground">Select a project to view agents.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Agents</h2>
        <select
          className="rounded border border-surface-0 bg-background px-3 py-1.5 text-xs text-foreground"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
          <option value="busy">Busy</option>
          <option value="error">Error</option>
        </select>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading agents\u2026</p>
      ) : !data?.agents.length ? (
        <p className="text-sm text-muted-foreground">No agents found.</p>
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
                  Last Seen
                </th>
                <th className="px-4 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-0/50">
              {data.agents.map((agent) => (
                <tr key={agent.id} className="transition-colors hover:bg-surface-0/20">
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">{agent.name}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={agent.status} />
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link
                      to={`/agents/${agent.id}`}
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
