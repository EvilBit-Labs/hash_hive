import { MotionConfig } from 'motion/react'

import { ConnectionIndicator } from '../components/features/connection-indicator'
import { CrackRateTrendChart } from '../components/features/crack-rate-chart'
import { StatCard } from '../components/features/stat-card'
import { SystemHealthCard } from '../components/features/system-health-card'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { useDashboardStats } from '../hooks/use-dashboard'
import { useSparkHistory } from '../hooks/use-spark-history'
import { useUiStore } from '../stores/ui'

export function DashboardPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const { data: stats, isLoading } = useDashboardStats()

  // Ring-buffer keys carry the project id so switching projects clears the
  // sparkline state cleanly. Hooks must run before the early return below,
  // but when no project is selected we pass `undefined` so the hook
  // short-circuits its append guard rather than silently accumulating
  // samples behind the empty state under a phantom `none:*` key.
  const projectKey = selectedProjectId ?? 'none'
  const agentsValue = selectedProjectId ? stats?.agents.online : undefined
  const campaignsValue = selectedProjectId ? stats?.campaigns.running : undefined
  const tasksValue = selectedProjectId ? stats?.tasks.running : undefined
  const crackedValue = selectedProjectId ? stats?.cracked.total : undefined
  const agentsSpark = useSparkHistory(`${projectKey}:agents`, agentsValue)
  const campaignsSpark = useSparkHistory(`${projectKey}:campaigns`, campaignsValue)
  const tasksSpark = useSparkHistory(`${projectKey}:tasks`, tasksValue)
  const crackedSpark = useSparkHistory(`${projectKey}:cracked`, crackedValue, 60)

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Dashboard</PageHeader>
        <EmptyState message="Select a project to view its dashboard." />
      </div>
    )
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader>Dashboard</PageHeader>
          <ConnectionIndicator />
        </div>

        <div aria-live="polite" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Agents"
            value={stats ? `${stats.agents.online} / ${stats.agents.total}` : ''}
            subtitle="Online"
            loading={isLoading}
            to="/agents"
            accent="--ctp-teal"
            sparkData={agentsSpark}
          />
          <StatCard
            title="Campaigns"
            value={stats?.campaigns.running ?? 0}
            subtitle="Running"
            loading={isLoading}
            to="/campaigns"
            accent="--info"
            sparkData={campaignsSpark}
          />
          <StatCard
            title="Tasks"
            value={stats?.tasks.running ?? 0}
            subtitle="Running"
            loading={isLoading}
            to="/campaigns"
            accent="--ctp-lavender"
            sparkData={tasksSpark}
          />
          <StatCard
            title="Cracked"
            value={stats?.cracked.total ?? 0}
            subtitle="Total hashes"
            loading={isLoading}
            to="/results"
            accent="--success"
            sparkData={crackedSpark}
            emphasis="primary"
          />
        </div>

        <CrackRateTrendChart data={crackedSpark} loading={isLoading} />

        <SystemHealthCard />
      </div>
    </MotionConfig>
  )
}
