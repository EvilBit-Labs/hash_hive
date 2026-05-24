import { mock } from 'bun:test'

type WebSocketListener = ((event: unknown) => void) | null

/**
 * Mock WebSocket class for testing real-time event handling.
 *
 * Usage:
 * ```ts
 * const { install, instances, restore } = installMockWebSocket();
 * // ... render component that creates WebSocket ...
 * const ws = instances[0];
 * ws.simulateOpen();
 * ws.simulateMessage({ type: 'crack_result', projectId: 1, data: {} });
 * restore();
 * ```
 */
export class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  url: string
  readyState: number = MockWebSocket.CONNECTING
  protocol = ''
  extensions = ''
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'

  onopen: WebSocketListener = null
  onclose: WebSocketListener = null
  onmessage: WebSocketListener = null
  onerror: WebSocketListener = null

  close = mock(() => {
    this.readyState = MockWebSocket.CLOSED
    // Trigger onclose if set (intentional close does NOT suppress this;
    // production code nulls onclose before calling close() when it wants to suppress)
    if (this.onclose) {
      this.onclose({ code: 1000, reason: '', wasClean: true })
    }
  })

  send = mock((_data: string | ArrayBuffer | Blob | ArrayBufferView) => {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('WebSocket is not open')
    }
  })

  addEventListener = mock(() => {})
  removeEventListener = mock(() => {})
  dispatchEvent = mock(() => true)

  constructor(url: string, _protocols?: string | string[]) {
    this.url = url
  }

  /** Simulate the WebSocket connection opening. */
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.({ type: 'open' })
  }

  /** Simulate receiving a message. Data will be JSON-stringified. */
  simulateMessage(data: unknown) {
    this.onmessage?.({
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data),
    })
  }

  /** Simulate the WebSocket connection closing. */
  simulateClose(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.({ type: 'close', code, reason, wasClean: code === 1000 })
  }

  /** Simulate a WebSocket error. */
  simulateError() {
    this.onerror?.({ type: 'error' })
  }
}

interface MockWebSocketInstall {
  /** All MockWebSocket instances created since install. */
  instances: MockWebSocket[]
  /** The mock constructor function for assertions. */
  constructorMock: ReturnType<typeof mock>
  /** Restore the original WebSocket global. */
  restore: () => void
}

/**
 * Replace the global `WebSocket` constructor with `MockWebSocket`.
 * Returns an object with `instances` array, constructor mock, and `restore()`.
 */
export function installMockWebSocket(): MockWebSocketInstall {
  const originalWebSocket = globalThis.WebSocket
  const instances: MockWebSocket[] = []

  const constructorMock = mock((url: string, protocols?: string | string[]) => {
    const ws = new MockWebSocket(url, protocols)
    instances.push(ws)
    return ws
  })

  globalThis.WebSocket = constructorMock as unknown as typeof WebSocket

  return {
    instances,
    constructorMock,
    restore: () => {
      globalThis.WebSocket = originalWebSocket
    },
  }
}
