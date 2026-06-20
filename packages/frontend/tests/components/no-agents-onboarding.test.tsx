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

  it('makes "Generate enrollment token" the primary action, routing to the agents page', () => {
    // The first real action is minting a token, which only happens on the
    // agents page. The hero leads with that CTA rather than a command that
    // can't run until a token exists.
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const cta = screen.getByRole('link', { name: /generate enrollment token/i })
    expect(cta.getAttribute('href')).toBe('/agents')
  })

  it('renders a focus-visible ring on the primary CTA for keyboard nav', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    const cta = screen.getByRole('link', { name: /generate enrollment token/i })
    expect(cta.className).toContain('focus-visible:ring-2')
  })

  it('shows the command as a labeled preview beneath the CTA, not as the hero', () => {
    renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
    expect(screen.getByText(/you'll then run this on each worker/i)).toBeDefined()
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

    it('flips the button label to "Copied" after a successful copy', async () => {
      renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
      fireEvent.click(screen.getByRole('button', { name: /copy command to clipboard/i }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Copied' })).toBeDefined()
      })
    })

    it('does not flip to "Copied" when the clipboard write rejects', async () => {
      writeText.mockImplementation(() => Promise.reject(new Error('denied')))
      renderWithProviders(<NoAgentsOnboarding serverOrigin="https://example.test" />)
      fireEvent.click(screen.getByRole('button', { name: /copy command to clipboard/i }))
      // Yield so the rejection settles.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
    })
  })
})
