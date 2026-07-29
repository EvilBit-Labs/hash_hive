import type { HashTypeWire, SplitReviewGroups } from '@hashhive/shared'

import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { SplitReviewStep } from '../../src/components/features/campaign-wizard/split-review-step'
import { cleanupAll, renderWithProviders } from '../test-utils'

afterEach(cleanupAll)

const HASH_TYPES: HashTypeWire[] = [
  { id: 1, name: 'MD5', hashcatMode: 0, category: 'Raw Hash' },
  { id: 2, name: 'NTLM', hashcatMode: 1000, category: 'Operating System' },
  { id: 3, name: 'SHA1', hashcatMode: 100, category: 'Raw Hash' },
]

function buildReview(over: Partial<SplitReviewGroups> = {}): SplitReviewGroups {
  return {
    parentHashListId: 9,
    confident: [{ id: 101, mode: 1000, itemCount: 500 }],
    ambiguous: [{ id: 102, candidateModes: [0, 100], itemCount: 250 }],
    unidentified: [{ id: 103, itemCount: 10 }],
    ...over,
  }
}

function noop() {
  // intentionally empty — default test double for unused callbacks
}

describe('SplitReviewStep', () => {
  it('renders a confident group as a read-only resolved row with its mode label', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    expect(screen.getByText('500 hashes')).toBeDefined()
    expect(screen.getByText('NTLM (mode 1000)')).toBeDefined()
  })

  it('renders an ambiguous group with a control for each candidate mode', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    expect(screen.getByText('250 hashes')).toBeDefined()
    expect(screen.getByRole('radio', { name: 'MD5 (mode 0)' })).toBeDefined()
    expect(screen.getByRole('radio', { name: 'SHA1 (mode 100)' })).toBeDefined()
    expect(screen.getByText('Pick a type')).toBeDefined()
  })

  it('renders the unidentified group as an informational note, not a control', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    expect(screen.getByText(/10 hashes need a type/)).toBeDefined()
  })

  it('disables Confirm until every ambiguous group has an assigned mode', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    const confirmButton = screen.getByRole('button', {
      name: 'Confirm & Create',
    }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
  })

  it('enables Confirm once the only ambiguous group has an assignment', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{ 102: 0 }}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    const confirmButton = screen.getByRole('button', {
      name: 'Confirm & Create',
    }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)
  })

  it('keeps Confirm disabled when only SOME ambiguous groups are assigned', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview({
          ambiguous: [
            { id: 102, candidateModes: [0, 100], itemCount: 250 },
            { id: 104, candidateModes: [1000, 5600], itemCount: 75 },
          ],
        })}
        hashTypes={HASH_TYPES}
        assignments={{ 102: 0 }}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    const confirmButton = screen.getByRole('button', {
      name: 'Confirm & Create',
    }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
  })

  it('calls onAssignmentChange with the group id and the picked mode', () => {
    const onAssignmentChange = mock((_subListId: number, _mode: number) => {
      // recorded via `mock`
    })

    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={onAssignmentChange}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'SHA1 (mode 100)' }))

    expect(onAssignmentChange).toHaveBeenCalledWith(102, 100)
  })

  it('calls onConfirm when Confirm is clicked and every ambiguous group is assigned', () => {
    const onConfirm = mock(() => {
      // recorded via `mock`
    })

    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{ 102: 100 }}
        onAssignmentChange={noop}
        onConfirm={onConfirm}
        onCancel={noop}
        isConfirming={false}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Create' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows "Creating..." and disables both buttons while confirming', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview()}
        hashTypes={HASH_TYPES}
        assignments={{ 102: 100 }}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={true}
      />
    )

    const confirmButton = screen.getByRole('button', { name: 'Creating...' }) as HTMLButtonElement
    const cancelButton = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(true)
    expect(cancelButton.disabled).toBe(true)
  })

  it('renders nothing for confident/ambiguous/unidentified sections that are empty', () => {
    renderWithProviders(
      <SplitReviewStep
        reviewGroups={buildReview({ confident: [], ambiguous: [], unidentified: [] })}
        hashTypes={HASH_TYPES}
        assignments={{}}
        onAssignmentChange={noop}
        onConfirm={noop}
        onCancel={noop}
        isConfirming={false}
      />
    )

    expect(screen.queryByText(/Resolved/)).toBeNull()
    expect(screen.queryByText(/Needs your input/)).toBeNull()
    expect(screen.queryByText(/need a type/)).toBeNull()
    // Confirm has nothing to gate on — an empty ambiguous list means
    // `.every()` is vacuously true, so Confirm is enabled.
    const confirmButton = screen.getByRole('button', {
      name: 'Confirm & Create',
    }) as HTMLButtonElement
    expect(confirmButton.disabled).toBe(false)
  })
})
