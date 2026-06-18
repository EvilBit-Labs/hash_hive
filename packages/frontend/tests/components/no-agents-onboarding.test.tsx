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

  it('embeds the provided serverOrigin into the enroll command', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://hashhive.lab" />)
    const block = screen.getByTestId('dashboard-no-agents-onboarding')
    expect(block.textContent ?? '').toContain('hashhive-agent enroll')
    expect(block.textContent ?? '').toContain('--server https://hashhive.lab')
  })

  it('uses an obvious placeholder for the enrollment token (no dishonest install.sh)', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const block = screen.getByTestId('dashboard-no-agents-onboarding')
    expect(block.textContent ?? '').toContain('<ENROLLMENT_TOKEN>')
    // The previous curl|sh install.sh command pointed at a 404 — it's gone.
    expect(block.textContent ?? '').not.toContain('install.sh')
  })

  it('links to the agents management page via an inline "agents page" link', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const link = screen.getByRole('link', { name: 'agents page' })
    expect(link.getAttribute('href')).toBe('/agents')
  })

  it('renders a focus-visible ring class on the agents-page link for keyboard nav', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const link = screen.getByRole('link', { name: 'agents page' })
    expect(link.className).toContain('focus-visible:ring-2')
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
      expect(String(argument)).toContain('hashhive-agent enroll')
      expect(String(argument)).toContain('--server https://hashhive.lab')
      expect(String(argument)).toContain('--token <ENROLLMENT_TOKEN>')
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
