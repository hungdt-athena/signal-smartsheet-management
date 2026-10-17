'use client'
// Every page opens the same way: the title (same words as the sidebar item), one
// line saying what the page is for, and the page's own actions on the right.
import type { ReactNode } from 'react'

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <h1 className="h-title">{title}</h1>
        {sub && <p className="h-sub">{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </div>
  )
}

/** The one Refresh button: "Refresh", and "Refreshing…" with a turning icon while it runs. */
export function RefreshButton({ onClick, loading, small = true }: { onClick: () => void; loading: boolean; small?: boolean }) {
  return (
    <button type="button" className={`btn${small ? ' btn-sm' : ''}`} onClick={onClick} disabled={loading}>
      <span className={loading ? 'spin' : ''} aria-hidden="true">↻</span>
      {loading ? 'Refreshing…' : 'Refresh'}
    </button>
  )
}
