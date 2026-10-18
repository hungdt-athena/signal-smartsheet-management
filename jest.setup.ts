import '@testing-library/jest-dom'

// jsdom has no IntersectionObserver. Several components already stubbed one locally
// (see report-review-table.test.tsx, tagging-pending.test.tsx) before the Individual
// tab's review table (Task 6) started mounting one on every render of that tab -
// which any test rendering ReportView now hits, whether or not it exercises that
// table. A single no-op stand-in here, global, is simpler than repeating the same
// stub in every file that happens to render the tab; a test that actually needs the
// sentinel to fire still installs its own firing stand-in and overwrites this one.
if (typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === 'undefined') {
  class NoopIntersectionObserver {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = NoopIntersectionObserver
}

// Next (14.1+) patches history.replaceState so useSearchParams follows it, and
// lib/use-url-state writes through it. Tests mock next/navigation, so mirror the
// patch: every replaceState fires 'test:urlchange', which the mocks subscribe to.
if (typeof window !== 'undefined') {
  const origReplaceState = window.history.replaceState.bind(window.history)
  window.history.replaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null) {
    origReplaceState(data, unused, url)
    window.dispatchEvent(new Event('test:urlchange'))
  }
}
