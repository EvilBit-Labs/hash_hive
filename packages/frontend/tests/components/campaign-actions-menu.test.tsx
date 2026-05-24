import { afterEach, describe, expect, it, mock } from 'bun:test'

import { CampaignActionsMenu } from '../../src/components/features/campaign-actions-menu'
import { cleanupAll, fireEvent, renderWithProviders, screen } from '../test-utils'

afterEach(cleanupAll)

describe('CampaignActionsMenu', () => {
  it('opens the menu when the trigger is clicked', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="draft" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    expect(screen.getByRole('menuitem', { name: 'Start' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'View Details' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeDefined()
  })

  it('disables Start when campaign is running', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="running" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    const start = screen.getByRole('menuitem', { name: 'Start' }) as HTMLButtonElement
    expect(start.disabled).toBe(true)
  })

  it('enables Pause when campaign is running', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="running" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    const pause = screen.getByRole('menuitem', { name: 'Pause' }) as HTMLButtonElement
    expect(pause.disabled).toBe(false)
  })

  it('disables Delete when campaign is not draft', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="running" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    const del = screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement
    expect(del.disabled).toBe(true)
  })

  it('enables Delete only when campaign is draft', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="draft" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    const del = screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement
    expect(del.disabled).toBe(false)
  })

  it('fires onAction with the action id and closes the menu when clicked', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="draft" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start' }))

    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction.mock.calls[0]?.[0]).toBe('start')
    expect(screen.queryByRole('menuitem', { name: 'Start' })).toBeNull()
  })

  it('always enables View Details regardless of status', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="completed" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    const view = screen.getByRole('menuitem', { name: 'View Details' }) as HTMLButtonElement
    expect(view.disabled).toBe(false)
  })

  it('closes the menu on Escape', () => {
    const onAction = mock(() => undefined)
    renderWithProviders(<CampaignActionsMenu status="draft" onAction={onAction} />)

    fireEvent.click(screen.getByLabelText('Campaign actions'))
    expect(screen.getByRole('menuitem', { name: 'Start' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menuitem', { name: 'Start' })).toBeNull()
  })
})
