/**
 * Frontend test setup for bun:test + Testing Library.
 *
 * Loaded via bun's --preload flag. Sets up a happy-dom window as the
 * global DOM environment for Testing Library to render into.
 */
import { Window } from 'happy-dom'

const window = new Window({ url: 'http://localhost:3000' })

// happy-dom v20 sets window.SyntaxError = undefined, but its internal
// SelectorParser calls `new this.window.SyntaxError(...)`. Patch it.
;(window as unknown as Record<string, unknown>)['SyntaxError'] = globalThis.SyntaxError

// Inject DOM globals that Testing Library expects
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLSelectElement: window.HTMLSelectElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  HTMLDivElement: window.HTMLDivElement,
  HTMLSpanElement: window.HTMLSpanElement,
  MutationObserver: window.MutationObserver,
  // happy-dom v20 ships ResizeObserver on window but the previous list
  // didn't surface it on globalThis. ReactFlow (loaded indirectly by
  // CampaignDetailPage and other graph-rendering pages) reads it from the
  // global scope at module-init time and throws `ReferenceError:
  // ResizeObserver is not defined` on Linux happy-dom — the macOS build
  // happens to have a fallback that masks this. Injecting the global
  // keeps the polyfill portable across runners.
  ResizeObserver: window.ResizeObserver,
  Node: window.Node,
  Text: window.Text,
  DocumentFragment: window.DocumentFragment,
  Element: window.Element,
  Event: window.Event,
  CustomEvent: window.CustomEvent,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
})
