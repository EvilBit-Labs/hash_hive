import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

export type CampaignActionId = 'start' | 'pause' | 'stop' | 'view' | 'delete';

interface CampaignActionsMenuProps {
  status: string;
  onAction: (action: CampaignActionId) => void;
  disabled?: boolean;
}

interface MenuItemSpec {
  id: CampaignActionId;
  label: string;
  destructive?: boolean;
  /** Statuses that enable this action. `null` means always-enabled. */
  enabledFor: string[] | null;
}

const MENU_ITEMS: MenuItemSpec[] = [
  { id: 'start', label: 'Start', enabledFor: ['draft', 'paused'] },
  { id: 'pause', label: 'Pause', enabledFor: ['running'] },
  { id: 'stop', label: 'Stop', enabledFor: ['running', 'paused'] },
  { id: 'view', label: 'View Details', enabledFor: null },
  { id: 'delete', label: 'Delete', enabledFor: ['draft'], destructive: true },
];

/**
 * Per-row dropdown for the campaign list. Items disable themselves based
 * on the campaign's current lifecycle status so a viewer cannot, for
 * example, click "Start" on a running campaign. The dropdown does not
 * own the confirmation flow — `onAction` fires immediately on click,
 * and the parent decides whether to open a modal or call the API.
 */
export function CampaignActionsMenu({ status, onAction, disabled }: CampaignActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative inline-block text-left">
      <button
        type="button"
        aria-label="Campaign actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          'inline-flex items-center rounded border border-surface-0 px-2 py-1 text-xs',
          'text-muted-foreground transition-colors hover:bg-surface-0/60 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
          role="menu"
          aria-label="Campaign actions"
          className={cn(
            'absolute right-0 z-20 mt-1 w-40 origin-top-right rounded-md border border-surface-0',
            'bg-mantle py-1 shadow-lg ring-1 ring-black/5'
          )}
        >
          {MENU_ITEMS.map((item) => {
            const enabled = item.enabledFor === null || item.enabledFor.includes(status);
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={!enabled}
                onClick={() => {
                  setOpen(false);
                  onAction(item.id);
                }}
                className={cn(
                  'block w-full px-3 py-1.5 text-left text-xs',
                  'transition-colors hover:bg-surface-0/60 disabled:opacity-40 disabled:cursor-not-allowed',
                  item.destructive ? 'text-destructive hover:text-destructive' : 'text-foreground'
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
