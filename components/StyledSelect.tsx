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

export function StyledSelect({ value, onChange, options, placeholder = '-- Select --', disabled, style }: StyledSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selectedLabel = options.find(o => o.value === value)?.label || ''

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          border: '1px solid #D4C4A0', borderRadius: 6,
          padding: '6px 8px', fontSize: 12, fontWeight: 600,
          background: disabled ? '#EFE3C8' : '#FAF5EC', color: '#2A1F08',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.6 : 1,
          textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value ? selectedLabel : <span style={{ color: '#9A8A6A' }}>{placeholder}</span>}
        </span>
        <span style={{ fontSize: 8, color: '#9A8A6A', marginLeft: 6, flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 50,
          background: '#3D3022', borderRadius: 8, padding: '3px 0',
          maxHeight: 220, overflowY: 'auto',
          boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
        }}>
          {options.map(opt => {
            const selected = opt.value === value
            return (
              <button
                type="button"
                key={opt.value}
                onClick={() => { onChange(opt.value); setOpen(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 10px', border: 'none',
                  background: selected ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: '#F5EDD8', fontSize: 12, fontWeight: selected ? 700 : 500,
                  cursor: 'pointer', textAlign: 'left',
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.background = selected ? 'rgba(255,255,255,0.1)' : 'transparent' }}
              >
                <span style={{ width: 14, flexShrink: 0, fontSize: 10, color: '#A8C44E' }}>
                  {selected ? '✓' : ''}
                </span>
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
