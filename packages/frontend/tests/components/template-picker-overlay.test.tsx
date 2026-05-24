import { afterEach, describe, expect, it, mock } from 'bun:test'

import { TemplatePickerOverlay } from '../../src/components/features/campaign-wizard/template-picker-overlay'
import { cleanup, fireEvent, renderWithProviders, screen } from '../test-utils'

afterEach(cleanup)

const NOOP = () => {}
const TEMPLATES = [
  { id: 1, name: 'Quick Crack', mode: 0, hashTypeId: null, wordlistId: 5, rulelistId: null },
  { id: 2, name: 'Mask Sweep', mode: 3, hashTypeId: null, wordlistId: null, rulelistId: null },
] as unknown as Parameters<typeof TemplatePickerOverlay>[0]['templates']

describe('TemplatePickerOverlay', () => {
  it('renders dialog semantics (role + aria-modal + aria-labelledby)', () => {
    renderWithProviders(
      <TemplatePickerOverlay
        templates={TEMPLATES}
        isPending={false}
        error={null}
        onPick={NOOP}
        onClose={NOOP}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('template-picker-title')
    expect(screen.getByText('Select a Template').id).toBe('template-picker-title')
  })

  it('moves initial focus to the Cancel button on mount', async () => {
    renderWithProviders(
      <TemplatePickerOverlay
        templates={TEMPLATES}
        isPending={false}
        error={null}
        onPick={NOOP}
        onClose={NOOP}
      />
    )
    // happy-dom needs a microtask for the ref-driven focus to settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const cancel = screen.getByText('Cancel')
    expect(document.activeElement).toBe(cancel)
  })

  it('closes when the user presses Escape', () => {
    const onClose = mock(() => {})
    renderWithProviders(
      <TemplatePickerOverlay
        templates={TEMPLATES}
        isPending={false}
        error={null}
        onPick={NOOP}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('traps Tab focus inside the dialog (Shift+Tab from the first element wraps to the last)', async () => {
    renderWithProviders(
      <TemplatePickerOverlay
        templates={TEMPLATES}
        isPending={false}
        error={null}
        onPick={NOOP}
        onClose={NOOP}
      />
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const cancel = screen.getByText('Cancel')
    const useButtons = screen.getAllByText('Use')
    const lastUse = useButtons[useButtons.length - 1]
    expect(lastUse).toBeDefined()
    if (!lastUse) return

    // Cancel has initial focus; Shift+Tab from Cancel must wrap to the
    // last interactive element (the last Use button).
    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(lastUse)
  })
})
