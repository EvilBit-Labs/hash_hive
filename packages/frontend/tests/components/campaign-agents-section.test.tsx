import { afterEach, describe, expect, it } from 'bun:test'

import type { CampaignActiveAgent } from '../../src/hooks/use-dashboard'

import { CampaignAgentsSection } from '../../src/components/features/campaign-agents-section'
import { cleanupAll, renderWithProviders, screen } from '../test-utils'

function makeAgent(overrides: Partial<CampaignActiveAgent> = {}): CampaignActiveAgent {
  return {
    agentId: 1,
    agentName: 'Rig Alpha',
    taskId: 100,
    attackId: 5,
    attackMode: 0,
    progress: null,
    speedHs: 1000,
    ...overrides,
  }
}

afterEach(cleanupAll)

describe('CampaignAgentsSection', () => {
  it('renders the empty state when no agents are active', () => {
    renderWithProviders(<CampaignAgentsSection agents={[]} />)
    expect(screen.getByText('No agents currently working on this campaign.')).toBeDefined()
  })

  it('renders a row per active agent', () => {
    renderWithProviders(
      <CampaignAgentsSection
        agents={[
          makeAgent({ agentId: 1, agentName: 'Rig Alpha' }),
          makeAgent({ agentId: 2, agentName: 'Rig Beta' }),
        ]}
      />
    )

    expect(screen.getByText('Rig Alpha')).toBeDefined()
    expect(screen.getByText('Rig Beta')).toBeDefined()
  })

  it('formats speed with thousands separators and the H/s suffix', () => {
    renderWithProviders(<CampaignAgentsSection agents={[makeAgent({ speedHs: 1500000 })]} />)
    expect(screen.getByText('1,500,000 H/s')).toBeDefined()
  })

  it('renders "--" for speed when speedHs is null', () => {
    renderWithProviders(<CampaignAgentsSection agents={[makeAgent({ speedHs: null })]} />)
    expect(screen.getByText('--')).toBeDefined()
  })

  it('shows current attack id and mode', () => {
    renderWithProviders(
      <CampaignAgentsSection agents={[makeAgent({ attackId: 42, attackMode: 3 })]} />
    )
    expect(screen.getByText('Attack #42 - mode 3')).toBeDefined()
  })
})
