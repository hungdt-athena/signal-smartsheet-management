'use client'
// The filter bar every list page uses. Order inside, left to right:
//   scope (category group, batch or date) → search → narrowing filters
//   (status, person, conclusion) → <FilterSpacer/> → <ClearFilters/> → <FilterCount/> → sort
// Every control is 32px tall. Page actions (Confirm, Extract, Quick stats) go in the
// page header, never in here.
import type { ReactNode } from 'react'

export function FilterBar({ children, className = '', ariaLabel = 'Filters' }: { children: ReactNode; className?: string; ariaLabel?: string }) {
  return <div className={`filter-row ${className}`.trim()} role="group" aria-label={ariaLabel}>{children}</div>
}

export function FilterSpacer() {
  return <span className="filter-spacer" aria-hidden="true" />
}

/** Shown only when at least one filter differs from its default. */
export function ClearFilters({ visible, onClear }: { visible: boolean; onClear: () => void }) {
  if (!visible) return null
  return <button type="button" className="btn btn-sm btn-link" onClick={onClear}>Clear filters</button>
}

/** "214 games" when nothing narrows the list, "38 of 214 games" when something does. */
export function FilterCount({ shown, total, noun = 'games', loading = false }: { shown: number; total?: number | null; noun?: string; loading?: boolean }) {
  if (loading) return <span className="filter-count" aria-live="polite">Loading…</span>
  const n = (x: number) => x.toLocaleString('en-US')
  const text = total != null && total !== shown ? `${n(shown)} of ${n(total)} ${noun}` : `${n(shown)} ${noun}`
  return <span className="filter-count" aria-live="polite">{text}</span>
}
