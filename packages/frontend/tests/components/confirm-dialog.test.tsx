import { fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { ConfirmDialog } from '../../src/components/ui/confirm-dialog'
import { cleanupAll, screen } from '../test-utils'

afterEach(() => {
  cleanupAll()
})

describe('ConfirmDialog', () => {
  it('renders nothing in the accessibility tree when closed', () => {
    render(
      <ConfirmDialog open={false} title="t" message="m" onConfirm={() => {}} onCancel={() => {}} />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('exposes a dialog with an accessible name from the title and the message body', () => {
    render(
      <ConfirmDialog
        open
        title="Delete cracker?"
        message="This removes the row and the file."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeDefined()
    // Accessible name comes from the Radix DialogTitle (aria-labelledby).
    expect(screen.getByRole('dialog', { name: 'Delete cracker?' })).toBeDefined()
    expect(screen.getByText('This removes the row and the file.')).toBeDefined()
  })

  it('renders confirm and cancel buttons by accessible name', () => {
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Keep' })).toBeDefined()
  })

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = mock()
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when the cancel button is clicked', () => {
    const onCancel = mock()
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        cancelLabel="Nevermind"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Nevermind' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('fires onCancel when Escape is pressed (Radix dismiss behavior)', () => {
    const onCancel = mock()
    render(<ConfirmDialog open title="t" message="m" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('disables both action buttons while busy', () => {
    render(
      <ConfirmDialog open title="t" message="m" busy onConfirm={() => {}} onCancel={() => {}} />
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBe(2)
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
  })

  it('does not fire onCancel on Escape while busy (in-flight action is not abandoned)', () => {
    const onCancel = mock()
    render(
      <ConfirmDialog open title="t" message="m" busy onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })
})
