import { useState } from 'react'

import { AgentErrorBadge } from '../components/features/agent-error-badge'
import { type AgentFilter, AgentFilterButtons } from '../components/features/agent-filter-buttons'
import { StatusBadge } from '../components/features/status-badge'
import { EmptyState } from '../components/ui/empty-state'
import { PageHeader } from '../components/ui/page-header'
import { Table, TableBody, TableHead, TableRow, Td, Th } from '../components/ui/table'
import { TextLink } from '../components/ui/text-link'
import { useAgents } from '../hooks/use-dashboard'
import { formatPrimaryEngine, getPrimaryEngine } from '../lib/agent-capabilities'
import { useUiStore } from '../stores/ui'

function gpuCount(hardwareProfile: Record<string, unknown> | null | undefined): number | null {
  if (!hardwareProfile) return null
  const gpus = (hardwareProfile as Record<string, unknown>)['gpus']
  if (Array.isArray(gpus)) return gpus.length
  return null
}

function formatCurrentTask(
  task:
    | {
        campaignName: string
        attackMode: number
      }
    | null
    | undefined
): string {
  if (!task) return '-'
  return `${task.campaignName} (mode ${task.attackMode})`
}

export function AgentsPage() {
  const selectedProjectId = useUiStore((s) => s.selectedProjectId)
  const [statusFilter, setStatusFilter] = useState<AgentFilter>('all')
  const { data, isLoading } = useAgents(
    statusFilter === 'all' ? undefined : { status: statusFilter }
  )

  if (!selectedProjectId) {
    return (
      <div className="space-y-4">
        <PageHeader>Agents</PageHeader>
        <EmptyState message="Select a project to view agents." />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader>Agents</PageHeader>
        <AgentFilterButtons value={statusFilter} onChange={setStatusFilter} />
      </div>

      <div aria-live="polite">
        {isLoading ? (
          <EmptyState message="Loading agents..." />
        ) : !data?.agents.length ? (
          <EmptyState message="No agents found." />
        ) : (
          <Table>
            <TableHead>
              <tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Last Seen</Th>
                <Th>Current Task</Th>
                <Th>Hardware</Th>
                <Th>Cracker</Th>
              </tr>
            </TableHead>
            <TableBody>
              {data.agents.map((agent) => {
                const engine = getPrimaryEngine(
                  agent.capabilities as Record<string, unknown> | null | undefined
                )
                const gpus = gpuCount(agent.hardwareProfile)
                const errorCount = agent.errorCount24h ?? 0
                const severity = agent.worstSeverity24h ?? null

                return (
                  <TableRow key={agent.id}>
                    <Td className="text-sm font-medium">
                      <div className="flex items-center gap-2">
                        <TextLink
                          to={`/agents/${agent.id}`}
                          className="text-foreground hover:text-primary text-sm"
                        >
                          {agent.name}
                        </TextLink>
                        <AgentErrorBadge
                          count={errorCount}
                          severity={severity}
                          agentId={agent.id}
                          hashTarget="#errors"
                        />
                      </div>
                    </Td>
                    <Td>
                      <StatusBadge status={agent.status} />
                    </Td>
                    <Td className="text-muted-foreground text-xs">
                      {agent.lastSeenAt ? new Date(agent.lastSeenAt).toLocaleString() : 'Never'}
                    </Td>
                    <Td className="text-muted-foreground text-xs">
                      {formatCurrentTask(agent.currentTask)}
                    </Td>
                    <Td className="text-muted-foreground text-xs">
                      {gpus === null ? '-' : `${gpus} GPU${gpus === 1 ? '' : 's'}`}
                    </Td>
                    <Td className="text-muted-foreground text-xs">{formatPrimaryEngine(engine)}</Td>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
