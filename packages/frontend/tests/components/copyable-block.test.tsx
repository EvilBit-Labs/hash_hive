import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { CopyableBlock } from '../../src/components/ui/copyable-block'
import { cleanupAll, fireEvent, renderWithProviders, screen, waitFor } from '../test-utils'

interface ClipboardLike {
  writeText: ReturnType<typeof mock>
}

interface NavigatorWithClipboard {
  clipboard?: ClipboardLike
}

afterEach(cleanupAll)

describe('CopyableBlock', () => {
  it('renders the value in a selectable block', () => {
    renderWithProviders(<CopyableBlock value="cst_42_secret" ariaLabel="Copy key" oneLine />)
    expect(screen.getByText('cst_42_secret')).toBeDefined()
  })

  describe('with a working clipboard', () => {
    let writeText: ReturnType<typeof mock>
    let originalClipboard: ClipboardLike | undefined

    beforeEach(() => {
      writeText = mock(() => Promise.resolve())
      originalClipboard = (navigator as NavigatorWithClipboard).clipboard
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
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

    it('writes the value to the clipboard and flips the label to the copied state', async () => {
      renderWithProviders(
        <CopyableBlock value="payload" ariaLabel="Copy command" copiedLabel="Command copied" />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
      expect(writeText).toHaveBeenCalledTimes(1)
      expect(String(writeText.mock.calls[0]?.[0] ?? '')).toBe('payload')
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Command copied' })).toBeDefined()
      })
    })
  })

  it('shows the manual-copy fallback when no clipboard is available (insecure context)', () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    try {
      renderWithProviders(<CopyableBlock value="payload" ariaLabel="Copy command" />)
      fireEvent.click(screen.getByRole('button', { name: 'Copy command' }))
      expect(screen.getByText(/select the text and copy manually/i)).toBeDefined()
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'clipboard', original)
      } else {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      }
    }
  })
})
