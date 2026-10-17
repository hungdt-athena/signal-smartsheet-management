'use client'
// One segmented control for every "pick one of a few" switch: category group,
// status, view (Batch/Monthly, Pending/History/Trends). 32px tall, so it lines up
// with every other control in a filter bar. Replaces .seg, .sl-seg, .rp-seg-btn
// and bare .seg-btn-premium buttons.

export interface SegOption<T extends string> {
  value: T
  label: string
  /** Optional count shown as a small badge after the label. */
  count?: number
  /** Tint the count (e.g. something needs attention). */
  countTone?: 'warn'
  disabled?: boolean
  title?: string
}

export function Seg<T extends string>({ value, onChange, options, ariaLabel, className = '' }: {
  value: T
  onChange: (v: T) => void
  options: SegOption<T>[]
  ariaLabel: string
  className?: string
}) {
  return (
    <div className={`seg-wrapper ${className}`.trim()} role="group" aria-label={ariaLabel}>
      {options.map(o => (
        <button key={o.value} type="button" title={o.title}
          className={`seg-btn-premium${o.value === value ? ' active' : ''}`}
          aria-pressed={o.value === value}
          disabled={o.disabled}
          onClick={() => { if (o.value !== value) onChange(o.value) }}>
          {o.label}
          {o.count != null && (
            <span className={`seg-count${o.countTone === 'warn' ? ' warn' : ''}`}>{o.count.toLocaleString('en-US')}</span>
          )}
        </button>
      ))}
    </div>
  )
}
