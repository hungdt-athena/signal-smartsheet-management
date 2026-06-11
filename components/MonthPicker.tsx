'use client'
import { useState, useEffect, useRef, useMemo } from 'react'

export interface YearMonth { year: number; month: number }

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function MonthPicker({ available, value, onChange }: {
  available: YearMonth[]
  value: YearMonth | null
  onChange: (v: YearMonth | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const years = useMemo(() => {
    const set = new Set(available.map(a => a.year))
    return Array.from(set).sort((a, b) => b - a)
  }, [available])

  const [hoveredYear, setHoveredYear] = useState<number | null>(null)
  const activeYear = hoveredYear ?? value?.year ?? years[0] ?? null

  const monthsForYear = useMemo(() =>
    available.filter(a => a.year === activeYear).map(a => a.month).sort((a, b) => a - b),
    [available, activeYear]
  )

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const label = value ? `${MONTH_NAMES[value.month]} ${value.year}` : 'All months'

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-sm" onClick={() => setOpen(!open)}
        style={{ minWidth: 130, justifyContent: 'space-between', gap: 6 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        {label}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 200,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: '0 8px 24px rgba(0,0,0,.25)', display: 'flex', minWidth: 260,
          overflow: 'hidden',
        }}>
          <div style={{ borderRight: '1px solid var(--border)', padding: '6px 0', minWidth: 80 }}>
            <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 600, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Year</div>
            <button
              onClick={() => { onChange(null); setOpen(false) }}
              onMouseEnter={() => setHoveredYear(null)}
              style={{
                display: 'block', width: '100%', padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 13, textAlign: 'left',
                background: !value ? 'var(--surface-3)' : 'transparent', color: !value ? 'var(--accent)' : 'var(--text)', fontWeight: !value ? 600 : 400,
              }}>
              All
            </button>
            {years.map(y => (
              <button key={y}
                onMouseEnter={() => setHoveredYear(y)}
                style={{
                  display: 'block', width: '100%', padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 13, textAlign: 'left',
                  background: activeYear === y ? 'var(--surface-3)' : 'transparent',
                  color: value?.year === y ? 'var(--accent)' : 'var(--text)',
                  fontWeight: value?.year === y ? 600 : 400,
                }}>
                {y}
              </button>
            ))}
          </div>

          {activeYear && (
            <div style={{ padding: '6px 0', minWidth: 160 }}>
              <div style={{ padding: '4px 12px', fontSize: 10, fontWeight: 600, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.5px' }}>Month</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2, padding: '2px 6px' }}>
                {monthsForYear.map(m => {
                  const selected = value?.year === activeYear && value?.month === m
                  return (
                    <button key={m}
                      onClick={() => { onChange({ year: activeYear, month: m }); setOpen(false) }}
                      style={{
                        padding: '6px 4px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, textAlign: 'center',
                        background: selected ? 'var(--accent)' : 'transparent',
                        color: selected ? '#fff' : 'var(--text)',
                        fontWeight: selected ? 600 : 400,
                      }}>
                      {MONTH_NAMES[m]}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
