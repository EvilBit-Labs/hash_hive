/**
 * Frontend test setup for bun:test + Testing Library.
 *
 * Loaded via bun's --preload flag. Sets up a happy-dom window as the
 * global DOM environment for Testing Library to render into.
 */
import { mock } from 'bun:test'
import { Window } from 'happy-dom'
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react'
import * as RechartsActual from 'recharts'

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
  // happy-dom v20 ships these on window but the previous list didn't
  // surface them on globalThis. ReactFlow (loaded indirectly by
  // CampaignDetailPage and other graph-rendering pages) reads
  // ResizeObserver + SVG element classes from the global scope at
  // module-init time and throws `ReferenceError` on Linux happy-dom —
  // the macOS build happens to have fallbacks that mask this. Injecting
  // them keeps the polyfill portable across runners.
  ResizeObserver: window.ResizeObserver,
  IntersectionObserver: window.IntersectionObserver,
  SVGElement: window.SVGElement,
  SVGSVGElement: window.SVGSVGElement,
  Image: window.Image,
  HTMLImageElement: window.HTMLImageElement,
  Node: window.Node,
  Text: window.Text,
  DocumentFragment: window.DocumentFragment,
  Element: window.Element,
  // Radix UI primitives (Dialog/Select/Tabs focus-scope + aria-hidden sibling
  // hiding) walk the DOM via document.createTreeWalker, which reads the
  // NodeFilter.* constants from global scope. happy-dom v20 ships these on
  // window but not globalThis, mirroring the ResizeObserver gap above.
  NodeFilter: window.NodeFilter,
  TreeWalker: window.TreeWalker,
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

// Recharts mock: happy-dom does not lay out parents with computed dimensions,
// so ResponsiveContainer measures 0x0 and the SVG never renders. Replace it
// with a fixed-size wrapper while preserving every other Recharts export.
// The factory MUST spread the real module — partial-shape factories drop
// AreaChart/Area/Tooltip/etc and downstream tests fail at module-init.
// Hoisted above any SUT import per docs/solutions/conventions/bun-test-mock-module-import-order.md.
//
// Real ResponsiveContainer measures its parent and injects `width` / `height`
// as numeric props on its single child. The mock mirrors that contract via
// `cloneElement` so child charts (AreaChart, LineChart, etc.) receive the
// same prop shape they do in production. Without this, a chart that branches
// on missing-dimension props could pass tests and fail at runtime.
mock.module('recharts', () => {
  const MOCK_WIDTH = 500
  const MOCK_HEIGHT = 200
  return {
    ...RechartsActual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) => {
      const child = isValidElement(children)
        ? cloneElement(children, { width: MOCK_WIDTH, height: MOCK_HEIGHT } as Record<
            string,
            unknown
          >)
        : children
      return createElement(
        'div',
        {
          style: { width: MOCK_WIDTH, height: MOCK_HEIGHT },
          'data-testid': 'recharts-responsive-container',
        },
        child
      )
    },
  }
})
