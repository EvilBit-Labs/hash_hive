import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { NoAgentsOnboarding } from '../../src/components/features/no-agents-onboarding'
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

interface ClipboardLike {
  writeText: ReturnType<typeof mock>
}

interface NavigatorWithClipboard {
  clipboard?: ClipboardLike
}

afterEach(cleanupAll)

describe('NoAgentsOnboarding', () => {
  it('renders the "Awaiting first agent" hero title', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    expect(screen.getByText('Awaiting first agent')).toBeDefined()
  })

  it('embeds the provided serverOrigin into the command', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://hashhive.lab" />)
    const block = screen.getByTestId('dashboard-no-agents-onboarding')
    expect(block.textContent ?? '').toContain('https://hashhive.lab/install.sh')
    expect(block.textContent ?? '').toContain('HASHHIVE_SERVER=https://hashhive.lab')
  })

  it('uses an obvious placeholder for the agent token', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    // <AGENT_TOKEN> appears twice: once in the command, once in the
    // "Replace <AGENT_TOKEN> with a token from the agents page" tip.
    // The structural test is that it appears at all.
    const block = screen.getByTestId('dashboard-no-agents-onboarding')
    expect(block.textContent ?? '').toContain('<AGENT_TOKEN>')
  })

  it('links to the agents management page', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const link = screen.getByRole('link', { name: 'Manage agents' })
    expect(link.getAttribute('href')).toBe('/agents')
  })

  describe('copy button', () => {
    let writeText: ReturnType<typeof mock>
    let originalClipboard: ClipboardLike | undefined

    beforeEach(() => {
      writeText = mock(() => Promise.resolve())
      originalClipboard = (navigator as NavigatorWithClipboard).clipboard
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      })
    })

    afterEach(() => {
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: originalClipboard,
        })
      } else {
        delete (navigator as NavigatorWithClipboard).clipboard
      }
    })

    it('writes the full command to the clipboard on click', () => {
      renderWithProviders(<NoAgentsOnboarding serverOrigin="https://hashhive.lab" />)
      fireEvent.click(screen.getByRole('button', { name: /copy command to clipboard/i }))
      expect(writeText).toHaveBeenCalledTimes(1)
      const calls = writeText.mock.calls
      const argument = calls.length > 0 && calls[0] ? calls[0][0] : ''
      expect(String(argument)).toContain('curl -fsSL https://hashhive.lab/install.sh')
      expect(String(argument)).toContain('HASHHIVE_TOKEN=<AGENT_TOKEN>')
    })

    it('flips the button label to "Command copied" after a successful copy', async () => {
      renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
      fireEvent.click(screen.getByRole('button', { name: /copy command to clipboard/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Command copied' })).toBeDefined()
      })
    })

    it('swallows clipboard write rejections silently (non-blocking action)', async () => {
      writeText.mockImplementation(() => Promise.reject(new Error('denied')))
      renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
      // Should not throw, should not flip to "Command copied".
      fireEvent.click(screen.getByRole('button', { name: /copy command to clipboard/i }))
      // Yield so the rejection settles.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByRole('button', { name: 'Command copied' })).toBeNull()
    })
  })
})
