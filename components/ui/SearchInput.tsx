'use client'
// The one search box: magnifier icon, 32px, a ✕ to clear. Goes right after the
// scope controls in a filter bar.

export function SearchInput({ value, onChange, placeholder = 'Search', width = 220, ariaLabel, autoFocus }: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  /** px number, or any CSS width such as '100%'. */
  width?: number | string
  ariaLabel?: string
  autoFocus?: boolean
}) {
  return (
    <span className="search-wrap" style={{ width }}>
      <span className="search-icon-abs" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </span>
      <input className="search-input" type="search" value={value} placeholder={placeholder}
        aria-label={ariaLabel || placeholder} autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)} style={{ width: '100%' }} />
      {value && (
        <button type="button" className="search-clear" aria-label="Clear search" onClick={() => onChange('')}>
          <IconX size={12} />
        </button>
      )}
    </span>
  )
}

export function IconX({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
