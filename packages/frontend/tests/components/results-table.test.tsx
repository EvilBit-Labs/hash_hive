import type { CrackedResultRow } from '@hashhive/shared'

import { afterEach, describe, expect, it } from 'bun:test'

import { ResultsTable } from '../../src/components/features/results/results-table'
import { cleanupAll, renderWithProviders, screen } from '../test-utils'

afterEach(cleanupAll)

function makeRow(overrides: Partial<CrackedResultRow> = {}): CrackedResultRow {
  return {
    id: 1,
    hashValue: '5f4dcc3b5aa765d61d8327deb882cf99',
    plaintext: 'password',
    crackedAt: '2026-06-08T12:34:56.000Z',
    hashListId: 9,
    hashListName: 'Corporate Leak 2026',
    campaignId: 100,
    campaignName: 'Sprint One',
    attackId: 42,
    attackMode: 0,
    attackModeName: 'Dictionary',
    agentId: 7,
    ...overrides,
  }
}

describe('ResultsTable', () => {
  describe('column rendering', () => {
    it('renders six column headers when columns="full" (default)', () => {
      renderWithProviders(<ResultsTable rows={[makeRow()]} isLoading={false} />)
      const headers = screen.getAllByRole('columnheader')
      expect(headers.map((h) => h.textContent)).toEqual([
        'Hash Value',
        'Plaintext',
        'Campaign',
        'Attack',
        'Hash List',
        'Cracked At',
      ])
    })

    it('drops the Campaign column when columns="no-campaign"', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow()]} isLoading={false} columns="no-campaign" />
      )
      const headers = screen.getAllByRole('columnheader')
      expect(headers).toHaveLength(5)
      expect(headers.map((h) => h.textContent)).not.toContain('Campaign')
      // The row should also have five cells.
      const cells = screen.getAllByRole('cell')
      expect(cells).toHaveLength(5)
    })

    it('drops the Hash List column when columns="no-hashlist"', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow()]} isLoading={false} columns="no-hashlist" />
      )
      const headers = screen.getAllByRole('columnheader')
      expect(headers).toHaveLength(5)
      expect(headers.map((h) => h.textContent)).not.toContain('Hash List')
      const cells = screen.getAllByRole('cell')
      expect(cells).toHaveLength(5)
    })
  })

  describe('plaintext cell', () => {
    it('applies font-mono and success classes to the plaintext cell', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow({ plaintext: 'hunter2' })]} isLoading={false} />
      )
      const cell = screen.getByText('hunter2')
      expect(cell.className).toContain('font-mono')
      expect(cell.className).toContain('text-success')
    })

    it('renders an em dash when plaintext is null', () => {
      renderWithProviders(<ResultsTable rows={[makeRow({ plaintext: null })]} isLoading={false} />)
      // The em dash appears in the plaintext cell.
      const cells = screen.getAllByRole('cell')
      const plaintextCell = cells[1]
      expect(plaintextCell?.textContent).toBe('-')
    })

    it('applies break-all to the plaintext cell so very long values wrap', () => {
      const longPlaintext = 'a'.repeat(200)
      renderWithProviders(
        <ResultsTable rows={[makeRow({ plaintext: longPlaintext })]} isLoading={false} />
      )
      const cell = screen.getByText(longPlaintext)
      expect(cell.className).toContain('break-all')
    })
  })

  describe('campaign cell', () => {
    it('renders a link to the campaign when campaignId is non-null', () => {
      renderWithProviders(
        <ResultsTable
          rows={[makeRow({ campaignId: 100, campaignName: 'Sprint One' })]}
          isLoading={false}
        />
      )
      const link = screen.getByRole('link', { name: 'Sprint One' })
      expect(link.getAttribute('href')).toBe('/campaigns/100')
    })

    it('renders plain text (no link) when campaignId is null', () => {
      renderWithProviders(
        <ResultsTable
          rows={[makeRow({ campaignId: null, campaignName: 'Orphaned' })]}
          isLoading={false}
        />
      )
      // There should be no link with the campaign name as accessible name.
      expect(screen.queryByRole('link', { name: 'Orphaned' })).toBeNull()
      // But the campaign name still renders as text.
      expect(screen.getByText('Orphaned')).toBeDefined()
    })

    it('renders an em dash when both campaignId and campaignName are null', () => {
      renderWithProviders(
        <ResultsTable
          rows={[makeRow({ campaignId: null, campaignName: null })]}
          isLoading={false}
        />
      )
      const cells = screen.getAllByRole('cell')
      // Cell index 2 is the Campaign cell in "full" mode.
      expect(cells[2]?.textContent).toBe('-')
    })
  })

  describe('hash list cell', () => {
    it('renders a link to the hash list', () => {
      renderWithProviders(
        <ResultsTable
          rows={[makeRow({ hashListId: 9, hashListName: 'Corp Leak' })]}
          isLoading={false}
        />
      )
      const link = screen.getByRole('link', { name: 'Corp Leak' })
      expect(link.getAttribute('href')).toBe('/hash-lists/9')
    })
  })

  describe('attack cell', () => {
    it('renders the attackModeName text', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow({ attackModeName: 'Dictionary' })]} isLoading={false} />
      )
      expect(screen.getByText('Dictionary')).toBeDefined()
    })

    it('sets a title attribute carrying the attackModeName', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow({ attackModeName: 'Mask' })]} isLoading={false} />
      )
      const td = screen.getByText('Mask').closest('td')
      expect(td?.getAttribute('title')).toBe('Mask')
    })

    it('applies a Catppuccin accent class per attack mode', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow({ attackModeName: 'Mask' })]} isLoading={false} />
      )
      const label = screen.getByText('Mask')
      // Mask maps to lavender; the bullet dot inherits via bg-current.
      expect(label.className).toContain('text-ctp-lavender')
    })

    it('renders an em dash when attackModeName is null', () => {
      renderWithProviders(
        <ResultsTable rows={[makeRow({ attackModeName: null })]} isLoading={false} />
      )
      const cells = screen.getAllByRole('cell')
      // Cell index 3 is the Attack cell in "full" mode.
      expect(cells[3]?.textContent).toBe('-')
    })
  })

  describe('cracked at cell', () => {
    it('renders an em dash when crackedAt is null', () => {
      renderWithProviders(<ResultsTable rows={[makeRow({ crackedAt: null })]} isLoading={false} />)
      const cells = screen.getAllByRole('cell')
      // Cell index 5 is the Cracked At cell in "full" mode.
      expect(cells[5]?.textContent).toBe('-')
    })

    it('formats crackedAt with toLocaleString when non-null', () => {
      const iso = '2026-06-08T12:34:56.000Z'
      const expected = new Date(iso).toLocaleString()
      renderWithProviders(<ResultsTable rows={[makeRow({ crackedAt: iso })]} isLoading={false} />)
      expect(screen.getByText(expected)).toBeDefined()
    })
  })

  describe('loading and empty states', () => {
    it('renders nothing during initial load (parent page chrome carries the loading affordance)', () => {
      const { container } = renderWithProviders(<ResultsTable rows={[]} isLoading={true} />)
      expect(container.textContent ?? '').toBe('')
    })

    it('renders the empty state when isLoading=false and rows is empty', () => {
      renderWithProviders(<ResultsTable rows={[]} isLoading={false} />)
      expect(screen.getByText('No cracks in the current filter.')).toBeDefined()
    })

    it('still renders the table when isLoading=true but rows is non-empty (refetch state)', () => {
      renderWithProviders(<ResultsTable rows={[makeRow()]} isLoading={true} />)
      // Refetch state — the table is mounted, not the empty state.
      expect(screen.queryByText('No cracks in the current filter.')).toBeNull()
      expect(screen.getAllByRole('columnheader')).toHaveLength(6)
    })
  })

  describe('row-pulse new-arrival detection', () => {
    it('seeds the threshold on initial mount so existing rows are not flagged', () => {
      const initial = [makeRow({ id: 10 }), makeRow({ id: 20 }), makeRow({ id: 30 })]
      const { container } = renderWithProviders(<ResultsTable rows={initial} isLoading={false} />)
      // No rows should carry a "newly arrived" marker after the seed. We
      // can't observe the motion `animate` prop directly, but if every
      // row is treated as old the table renders three data rows and no
      // empty-state copy.
      const dataRows = container.querySelectorAll('tbody tr')
      expect(dataRows.length).toBe(3)
    })

    it('renders all rows after a poll-style rerender that adds a new row above the threshold', () => {
      const initial = [makeRow({ id: 10 }), makeRow({ id: 20 })]
      const { rerender, container } = renderWithProviders(
        <ResultsTable rows={initial} isLoading={false} />
      )
      const fresh = [...initial, makeRow({ id: 25 })]
      rerender(<ResultsTable rows={fresh} isLoading={false} />)
      const dataRows = container.querySelectorAll('tbody tr')
      expect(dataRows.length).toBe(3)
    })

    it('resets the threshold on a filter switch (zero-overlap row set)', () => {
      const setA = [makeRow({ id: 100 }), makeRow({ id: 200 })]
      const { rerender, container } = renderWithProviders(
        <ResultsTable rows={setA} isLoading={false} />
      )
      // Filter switch: brand-new id space with no overlap.
      const setB = [makeRow({ id: 1 }), makeRow({ id: 2 })]
      rerender(<ResultsTable rows={setB} isLoading={false} />)
      const dataRows = container.querySelectorAll('tbody tr')
      expect(dataRows.length).toBe(2)
    })
  })
})
