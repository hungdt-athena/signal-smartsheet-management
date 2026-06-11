'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'

interface MultiSelectProps {
  value: string[]
  onChange: (value: string[]) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
  style?: React.CSSProperties
}

interface MenuPos { top?: number; bottom?: number; left: number; width: number; maxHeight: number }

export function MultiSelect({ value, onChange, options, placeholder = 'Select', disabled, style }: MultiSelectProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<MenuPos | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const updatePos = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    const spaceBelow = window.innerHeight - r.bottom
    const spaceAbove = r.top
    const flipUp = spaceBelow < 200 && spaceAbove > spaceBelow
    setPos(flipUp
      ? { bottom: window.innerHeight - r.top + 5, left: r.left, width: r.width, maxHeight: Math.min(280, spaceAbove - 12) }
      : { top: r.bottom + 5, left: r.left, width: r.width, maxHeight: Math.min(280, spaceBelow - 12) })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePos()
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    window.addEventListener('scroll', updatePos, true)
    window.addEventListener('resize', updatePos)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('scroll', updatePos, true)
      window.removeEventListener('resize', updatePos)
    }
  }, [open, updatePos])

  function toggle(v: string) {
    if (value.includes(v)) onChange(value.filter(x => x !== v))
    else onChange([...value, v])
  }

  const label = value.length === 0
    ? placeholder
    : value.length === 1
      ? options.find(o => o.value === value[0])?.label ?? '1 selected'
      : `${value.length} selected`

  return (
    <div ref={ref} className="ssel" style={style}>
      <button
        ref={btnRef}
        type="button"
        className="ssel-btn"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
      >
        <span style={{ color: value.length > 0 ? 'var(--text)' : 'var(--faint)' }}>
          {label}
        </span>
        <span className="chev">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="ssel-menu"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}>
          {options.map(opt => {
            const checked = value.includes(opt.value)
            return (
              <div key={opt.value}
                className={'ssel-opt msel-opt' + (checked ? ' sel' : '')}
                onClick={() => toggle(opt.value)}>
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 16, height: 16, borderRadius: 3, flexShrink: 0,
                  border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: checked ? 'var(--accent)' : 'transparent',
                  transition: 'all 0.12s ease',
                }}>
                  {checked && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                      stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{opt.label}</span>
              </div>
            )
          })}
        </div>,
        document.body
      )}
    </div>
  )
}
