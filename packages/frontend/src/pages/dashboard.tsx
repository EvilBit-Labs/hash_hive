import { ConnectionIndicator } from '../components/features/connection-indicator'
import { StatCard } from '../components/features/stat-card'
import { SystemHealthCard } from '../components/features/system-health-card'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { useDashboardStats } from '../hooks/use-dashboard'
import { useUiStore } from '../stores/ui'

export function DashboardPage() {
  const { selectedProjectId } = useUiStore()
  const { data: stats, isLoading } = useDashboardStats()

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Dashboard</PageHeader>
        <EmptyState message="Select a project to view its dashboard." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <PageHeader>Dashboard</PageHeader>
        <ConnectionIndicator />
      </div>

      <div aria-live="polite" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Agents"
          value={stats ? `${stats.agents.online} / ${stats.agents.total}` : '--'}
          subtitle="Online"
          loading={isLoading}
          to="/agents"
          accent="--ctp-teal"
        />
        <StatCard
          title="Campaigns"
          value={stats?.campaigns.running ?? '--'}
          subtitle="Running"
          loading={isLoading}
          to="/campaigns"
          accent="--info"
        />
        <StatCard
          title="Tasks"
          value={stats?.tasks.running ?? '--'}
          subtitle="Running"
          loading={isLoading}
          to="/campaigns"
          accent="--ctp-lavender"
        />
        <StatCard
          title="Cracked"
          value={stats?.cracked.total ?? '--'}
          subtitle="Total hashes"
          loading={isLoading}
          to="/results"
          accent="--success"
        />
      </div>

      <SystemHealthCard />
    </div>
  )
}
