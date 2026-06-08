'use client'
import { useState, useRef, useEffect } from 'react'

interface StyledSelectProps {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  required?: boolean
  style?: React.CSSProperties
}

export function StyledSelect({ value, onChange, options, placeholder = 'Select', disabled, style }: StyledSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selectedLabel = options.find(o => o.value === value)?.label

  return (
    <div ref={ref} className="ssel" style={style}>
      <button
        type="button"
        className="ssel-btn"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
      >
        <span style={{ color: selectedLabel ? 'var(--text)' : 'var(--faint)' }}>
          {selectedLabel ?? placeholder}
        </span>
        <span className="chev">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="ssel-menu">
          {options.map(opt => (
            <div key={opt.value}
              className={'ssel-opt' + (opt.value === value ? ' sel' : '')}
              onClick={() => { onChange(opt.value); setOpen(false) }}>
              {opt.label}
              {opt.value === value && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
