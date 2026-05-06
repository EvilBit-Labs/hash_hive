import { afterEach, describe, expect, it, mock } from 'bun:test';
import { render } from '@testing-library/react';
import { ConfirmDialog } from '../../src/components/ui/confirm-dialog';
import { cleanupAll, screen } from '../test-utils';

afterEach(() => {
  cleanupAll();
});

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} title="t" message="m" onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title and message when open', () => {
    render(
      <ConfirmDialog
        open
        title="Delete cracker?"
        message="This removes the row and the file."
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText('Delete cracker?')).toBeDefined();
    expect(screen.getByText('This removes the row and the file.')).toBeDefined();
  });

  it('fires onConfirm when the confirm button is clicked', () => {
    const onConfirm = mock();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />
    );
    screen.getByText('Delete').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onCancel when the cancel button is clicked', () => {
    const onCancel = mock();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        cancelLabel="Nevermind"
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    screen.getByText('Nevermind').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while busy', () => {
    render(
      <ConfirmDialog open title="t" message="m" busy onConfirm={() => {}} onCancel={() => {}} />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});
