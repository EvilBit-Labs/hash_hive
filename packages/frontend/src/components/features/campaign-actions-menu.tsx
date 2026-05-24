import { useEffect, useRef, useState } from 'react'

import { cn } from '../../lib/utils'

export type CampaignActionId = 'start' | 'pause' | 'stop' | 'view' | 'delete'

interface CampaignActionsMenuProps {
  status: string
  onAction: (action: CampaignActionId) => void
  disabled?: boolean
}

interface MenuItemSpec {
  id: CampaignActionId
  label: string
  destructive?: boolean
  /** Statuses that enable this action. `null` means always-enabled. */
  enabledFor: string[] | null
}

const MENU_ITEMS: MenuItemSpec[] = [
  { id: 'start', label: 'Start', enabledFor: ['draft', 'paused'] },
  { id: 'pause', label: 'Pause', enabledFor: ['running'] },
  { id: 'stop', label: 'Stop', enabledFor: ['running', 'paused'] },
  { id: 'view', label: 'View Details', enabledFor: null },
  { id: 'delete', label: 'Delete', enabledFor: ['draft'], destructive: true },
]

/**
 * Per-row dropdown for the campaign list. Items disable themselves based
 * on the campaign's current lifecycle status so a viewer cannot, for
 * example, click "Start" on a running campaign. The dropdown does not
 * own the confirmation flow — `onAction` fires immediately on click,
 * and the parent decides whether to open a modal or call the API.
 *
 * Keyboard model (WAI-ARIA menu pattern):
 *   - Enter / Space on the trigger opens the menu and focuses the first
 *     enabled item.
 *   - ArrowDown / ArrowUp move roving focus to the next / previous
 *     enabled item, wrapping at both ends.
 *   - Home / End jump to the first / last enabled item.
 *   - Enter / Space on an item fires the action and closes the menu.
 *   - Escape closes the menu and returns focus to the trigger.
 *   - Click outside closes the menu without selecting.
 */
export function CampaignActionsMenu({ status, onAction, disabled }: CampaignActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number>(0)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Indices of enabled menu items — roving focus skips disabled rows
  // so keyboard users do not land on inert targets.
  const enabledIndices = MENU_ITEMS.map((item, i) =>
    item.enabledFor === null || item.enabledFor.includes(status) ? i : -1
  ).filter((i) => i >= 0)

  // When the menu opens, focus the first enabled item.
  useEffect(() => {
    if (!open) return
    const firstEnabled = enabledIndices[0]
    if (firstEnabled !== undefined) {
      setActiveIndex(firstEnabled)
      itemRefs.current[firstEnabled]?.focus()
    }
  }, [open, enabledIndices])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  function moveFocus(direction: 'next' | 'prev' | 'first' | 'last') {
    if (enabledIndices.length === 0) return
    const currentPos = enabledIndices.indexOf(activeIndex)
    let nextPos: number
    switch (direction) {
      case 'next':
        nextPos = currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length
        break
      case 'prev':
        nextPos =
          currentPos < 0
            ? enabledIndices.length - 1
            : (currentPos - 1 + enabledIndices.length) % enabledIndices.length
        break
      case 'first':
        nextPos = 0
        break
      case 'last':
        nextPos = enabledIndices.length - 1
        break
    }
    const nextIndex = enabledIndices[nextPos] ?? enabledIndices[0]
    if (nextIndex === undefined) return
    setActiveIndex(nextIndex)
    itemRefs.current[nextIndex]?.focus()
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        moveFocus('next')
        break
      case 'ArrowUp':
        event.preventDefault()
        moveFocus('prev')
        break
      case 'Home':
        event.preventDefault()
        moveFocus('first')
        break
      case 'End':
        event.preventDefault()
        moveFocus('last')
        break
      default:
        break
    }
  }

  function selectItem(item: MenuItemSpec) {
    setOpen(false)
    onAction(item.id)
    triggerRef.current?.focus()
  }

  return (
    <div ref={wrapperRef} className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Campaign actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          'border-surface-0 inline-flex items-center rounded border px-2 py-1 text-xs',
          'text-muted-foreground hover:bg-surface-0/60 hover:text-foreground transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
          'disabled:opacity-50'
        )}
        onClick={() => setOpen((prev) => !prev)}
      >
        Actions
        <span aria-hidden="true" className="ml-1">
          ▾
        </span>
      </button>
      {open && (
        <div
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- WAI-ARIA menu pattern is the right semantic here; the button children are interactive and carry their own roles
          role="menu"
          tabIndex={-1}
          aria-label="Campaign actions"
          onKeyDown={handleMenuKeyDown}
          className={cn(
            'border-surface-0 absolute right-0 z-20 mt-1 w-40 origin-top-right rounded-md border',
            'bg-mantle py-1 shadow-lg ring-1 ring-black/5'
          )}
        >
          {MENU_ITEMS.map((item, index) => {
            const enabled = item.enabledFor === null || item.enabledFor.includes(status)
            return (
              <button
                key={item.id}
                ref={(el) => {
                  itemRefs.current[index] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={activeIndex === index ? 0 : -1}
                disabled={!enabled}
                onClick={() => selectItem(item)}
                className={cn(
                  'block w-full px-3 py-1.5 text-left text-xs',
                  'hover:bg-surface-0/60 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  'focus:bg-surface-0/60 focus:outline-none',
                  item.destructive ? 'text-destructive hover:text-destructive' : 'text-foreground'
                )}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
