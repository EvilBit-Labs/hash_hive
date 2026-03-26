import { ConnectionIndicator } from '../components/features/connection-indicator';
import { StatCard } from '../components/features/stat-card';
import { useDashboardStats } from '../hooks/use-dashboard';
import { useEvents } from '../hooks/use-events';
import { useUiStore } from '../stores/ui';

export function DashboardPage() {
  const { selectedProjectId } = useUiStore();
  const { data: stats, isLoading } = useDashboardStats();

  // Query invalidation is handled inside useEvents — no duplicate handler needed
  const { connected } = useEvents();

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        <p className="text-sm text-muted-foreground">Select a project to view its dashboard.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Dashboard</h2>
        <ConnectionIndicator connected={connected} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Agents"
          value={stats ? `${stats.agents.online} / ${stats.agents.total}` : '--'}
          subtitle="Online"
          loading={isLoading}
          to="/agents"
        />
        <StatCard
          title="Campaigns"
          value={stats?.campaigns.running ?? '--'}
          subtitle="Running"
          loading={isLoading}
          to="/campaigns"
        />
        <StatCard
          title="Tasks"
          value={stats?.tasks.running ?? '--'}
          subtitle="Running"
          loading={isLoading}
          to="/campaigns"
        />
        <StatCard
          title="Cracked"
          value={stats?.cracked.total ?? '--'}
          subtitle="Total hashes"
          loading={isLoading}
          to="/results"
        />
      </div>
    </div>
  );
}
