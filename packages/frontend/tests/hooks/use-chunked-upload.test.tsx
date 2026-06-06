import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { useChunkedUpload } from '../../src/hooks/use-chunked-upload'

afterEach(cleanup)

const mockOrchestrate = mock(async (_args: { signal?: AbortSignal }) => 1)
const mockClearUploadState = mock((_id: string) => {})

mock.module('../../src/lib/chunked-upload/engine', () => ({
  orchestrateUpload: mockOrchestrate,
}))
mock.module('../../src/lib/chunked-upload/persistence', () => ({
  clearUploadState: mockClearUploadState,
}))

describe('useChunkedUpload — unmount cleanup (issue #163 review)', () => {
  it('aborts the in-flight controller when the hook unmounts mid-upload', async () => {
    mockOrchestrate.mockReset()
    let capturedSignal: AbortSignal | undefined
    // Hold the orchestration promise open so we can unmount while
    // the upload is in-flight. The engine takes the signal and would
    // normally tear down its own PUTs on abort.
    let resolveOrchestrate: ((value: number) => void) | undefined
    mockOrchestrate.mockImplementationOnce(
      async (args: { signal?: AbortSignal }): Promise<number> => {
        capturedSignal = args.signal
        return new Promise<number>((resolve) => {
          resolveOrchestrate = resolve
        })
      }
    )

    const { result, unmount } = renderHook(() => useChunkedUpload())

    const file = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
    // Fire-and-forget the upload — it never resolves until we let it.
    void result.current.start(file, 'wordlists', 'test')
    // Wait a tick for the start() to actually call orchestrateUpload
    // and stash the signal.
    await new Promise((r) => setTimeout(r, 10))
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal?.aborted).toBe(false)

    // Unmounting the consumer (the resources tabs subtree) MUST
    // abort the controller so PUTs stop. Without the useEffect
    // cleanup, this assertion would fail.
    unmount()

    expect(capturedSignal?.aborted).toBe(true)

    // Resolve the hanging promise so the test runtime doesn't hold
    // the open handle. (The actual code path would catch the abort
    // and dispatch RESET — but the dispatch lands on the unmounted
    // reducer; either way the test runtime is unblocked here.)
    resolveOrchestrate?.(1)
  })

  it('does NOT clear persisted resume state on unmount — only explicit cancel does', async () => {
    mockClearUploadState.mockReset()
    mockOrchestrate.mockReset()
    mockOrchestrate.mockImplementationOnce(
      async (_args: { signal?: AbortSignal }): Promise<number> => new Promise(() => {})
    )

    const { result, unmount } = renderHook(() => useChunkedUpload())
    const file = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
    void result.current.start(file, 'wordlists', 'resumable')
    await new Promise((r) => setTimeout(r, 10))

    unmount()

    // Resume token is preserved — the whole point of the persistence
    // layer is to survive tab/route churn. clearUploadState is only
    // called from the explicit cancel() path or on successful
    // completion.
    expect(mockClearUploadState).not.toHaveBeenCalled()
  })

  it('explicit cancel() DOES clear persisted resume state', async () => {
    mockClearUploadState.mockReset()
    mockOrchestrate.mockReset()
    mockOrchestrate.mockImplementationOnce(
      async (_args: { signal?: AbortSignal }): Promise<number> => new Promise(() => {})
    )

    const { result } = renderHook(() => useChunkedUpload())
    const file = new File(['x'], 'x.bin', { type: 'application/octet-stream' })
    void result.current.start(file, 'wordlists', 'cancellable')
    await new Promise((r) => setTimeout(r, 10))

    // Explicit cancel — operator chose to abandon the upload.
    result.current.cancel()

    expect(mockClearUploadState).toHaveBeenCalledWith('wordlists-cancellable-1')
  })
})
