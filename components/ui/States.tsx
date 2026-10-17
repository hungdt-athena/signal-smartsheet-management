'use client'
// Empty and error states for lists and cards. One sentence that says why, plus at
// most one action. A failed load is never shown as "nothing here".
import type { ReactNode } from 'react'

export function EmptyState({ children, action }: { children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="state-empty">
      <span>{children}</span>
      {action && <button type="button" className="btn btn-sm" onClick={action.onClick}>{action.label}</button>}
    </div>
  )
}

export function ErrorState({ children = 'Could not load.', onRetry }: { children?: ReactNode; onRetry?: () => void }) {
  return (
    <div className="state-error" role="alert">
      <span>{children}</span>
      {onRetry && <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  )
}

/** Placeholder rows while a table loads for the first time. One cell per column. */
export function SkeletonRows({ widths, rows = 5 }: { widths: number[]; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} aria-hidden="true">
          {widths.map((w, c) => <td key={c}><span className="skeleton" style={{ width: w, height: 14 }} /></td>)}
        </tr>
      ))}
    </>
  )
}
