import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { useCallback, useState } from 'react';
import {
  useCreateCrackerBinary,
  useDeleteCrackerBinary,
  useUpdateCrackerBinary,
  useUploadCrackerFile,
} from '../../src/hooks/use-crackers';
import { mockFetch, restoreFetch } from '../mocks/fetch';
import { cleanupAll, createTestQueryClient, screen, waitFor } from '../test-utils';

let fetchMock: ReturnType<typeof mockFetch>;

afterEach(() => {
  cleanupAll();
  if (fetchMock) restoreFetch(fetchMock);
});

beforeEach(() => {
  // Reset between tests so error state from a previous test does not leak.
});

interface MutationProbeProps {
  trigger: () => Promise<unknown>;
  onErrorMessage: (message: string) => void;
}

function MutationProbe({ trigger, onErrorMessage }: MutationProbeProps) {
  const [error, setError] = useState<string | null>(null);
  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onErrorMessage(message);
    },
    [onErrorMessage]
  );

  // The probe is reused across hooks — caller wires `trigger` to whichever
  // mutation it wants to exercise.
  return (
    <div>
      <button type="button" onClick={() => trigger().catch(() => {})} data-testid="trigger">
        run
      </button>
      <span data-testid="error">{error ?? 'no-error'}</span>
      {/* Pass the setter to whichever hook the caller exercises */}
      <span data-testid="setter" data-handler={reportError.length} />
    </div>
  );
}

function CreateProbe({ onErr }: { onErr: (m: string) => void }) {
  const create = useCreateCrackerBinary({ onError: onErr });
  return (
    <MutationProbe
      onErrorMessage={() => {}}
      trigger={() =>
        create.mutateAsync({ engine: 'hashcat', version: '6.2.6', platform: 'linux-x64' })
      }
    />
  );
}

function UpdateProbe({ onErr }: { onErr: (m: string) => void }) {
  const update = useUpdateCrackerBinary({ onError: onErr });
  return (
    <MutationProbe
      onErrorMessage={() => {}}
      trigger={() => update.mutateAsync({ id: 42, isActive: false })}
    />
  );
}

function DeleteProbe({ onErr }: { onErr: (m: string) => void }) {
  const del = useDeleteCrackerBinary({ onError: onErr });
  return <MutationProbe onErrorMessage={() => {}} trigger={() => del.mutateAsync(42)} />;
}

function UploadProbe({ onErr }: { onErr: (m: string) => void }) {
  const upload = useUploadCrackerFile({ onError: onErr });
  return (
    <MutationProbe
      onErrorMessage={() => {}}
      trigger={() => upload.mutateAsync({ id: 42, file: new File(['hi'], 'h.txt') })}
    />
  );
}

function renderProbe(node: React.ReactNode) {
  return render(<QueryClientProvider client={createTestQueryClient()}>{node}</QueryClientProvider>);
}

describe('useCreateCrackerBinary onError', () => {
  it('invokes onError with server error message on 409', async () => {
    fetchMock = mockFetch({
      '/dashboard/crackers': {
        POST: {
          status: 409,
          body: {
            error: { code: 'CRACKER_DUPLICATE', message: 'duplicate engine/version/platform' },
          },
        },
      },
    });

    let captured: string | null = null;
    const onErr = (m: string) => {
      captured = m;
    };
    renderProbe(<CreateProbe onErr={onErr} />);
    screen.getByTestId('trigger').click();

    await waitFor(() => {
      expect(captured).not.toBeNull();
    });
    expect(captured).toContain('duplicate');
  });
});

describe('useUpdateCrackerBinary onError', () => {
  it('invokes onError on 500', async () => {
    fetchMock = mockFetch({
      '/dashboard/crackers/42': {
        PATCH: {
          status: 500,
          body: { error: { code: 'CRACKER_UPDATE_FAILED', message: 'update failed' } },
        },
      },
    });

    let captured: string | null = null;
    renderProbe(<UpdateProbe onErr={(m) => (captured = m)} />);
    screen.getByTestId('trigger').click();

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toContain('update failed');
  });
});

describe('useDeleteCrackerBinary onError', () => {
  it('invokes onError on 502 (storage delete failure)', async () => {
    fetchMock = mockFetch({
      '/dashboard/crackers/42': {
        DELETE: {
          status: 502,
          body: {
            error: {
              code: 'CRACKER_STORAGE_DELETE_FAILED',
              message: 'Failed to delete the stored binary',
            },
          },
        },
      },
    });

    let captured: string | null = null;
    renderProbe(<DeleteProbe onErr={(m) => (captured = m)} />);
    screen.getByTestId('trigger').click();

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toContain('Failed to delete');
  });
});

describe('useUploadCrackerFile error parsing', () => {
  it('surfaces the server error message when JSON parses', async () => {
    fetchMock = mockFetch({
      '/api/v1/dashboard/crackers/42/upload': {
        POST: {
          status: 413,
          body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'over the cap' } },
        },
      },
    });

    let captured: string | null = null;
    renderProbe(<UploadProbe onErr={(m) => (captured = m)} />);
    screen.getByTestId('trigger').click();

    await waitFor(() => expect(captured).not.toBeNull());
    expect(captured).toContain('over the cap');
  });
});
