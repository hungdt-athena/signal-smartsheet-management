'use client'
// The one on/off switch (role="switch"). Uses the existing .sw styles.

export function Switch({ checked, onChange, label, disabled, title, ariaLabel }: {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  disabled?: boolean
  title?: string
  /** Name for screen readers when there is no visible label. */
  ariaLabel?: string
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label ? undefined : (ariaLabel ?? title)}
      className={`sw${checked ? ' sw-on' : ''}`} disabled={disabled} title={title}
      onClick={() => onChange(!checked)}>
      <span className="sw-track"><span className="sw-knob" /></span>
      {label && <span className="sw-text">{label}</span>}
    </button>
  )
}
