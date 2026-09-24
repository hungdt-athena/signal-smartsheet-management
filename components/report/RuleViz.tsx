'use client'
// Live illustrations for Config -> Alert rules. Each one draws THIS window's people
// against one rule, so moving a slider shows who the rule would flag before anything
// is saved. Four forms, picked by what the rule compares:
//
//   ThresholdBars - one value per person against a limit (games, shares, gaps)
//   RatioStrip    - a person's rate as a multiple of the rest of the team, log scale,
//                   with the two "too little" / "too much" zones
//   SpreadLine    - where everyone's bypass share sits, and the gap between the ends
//   Meter         - one team number against its limit
//
// Emphasis, not categorical: the people a rule flags are drawn in the warning amber
// and carry a "!" beside their name, everyone else is one grey, and people the rule
// does not look at (too few games) are a lighter grey. Colour is never the only cue -
// the flagged state is also in the label and the sentence under the chart.
import { useEffect, useRef, useState, type ReactNode } from 'react'

export const VIZ = {
  flag: '#d97706',      // status: warning (marks only - text stays in text tokens)
  flagWash: '#fbf1de',  // the zone a flag lives in
  base: '#8b97aa',      // everyone the rule looked at and did not flag
  muted: '#dde2ea',     // not looked at
  grid: '#e7e9ee',
  ink: '#1a1c22',
  sub: '#59606e',
  faint: '#99a0ad',
}

// 'hit' = the people a NEUTRAL readout is about (e.g. whose score gets discounted):
// the accent hue, because it is emphasis without being an alert.
export type VizState = 'flag' | 'hit' | 'base' | 'muted'
const HIT = '#2a78d6'

// Draw in real pixels. A fixed viewBox scaled to the card made an 11px label 16px on
// a wide screen and 8px on a narrow one; measuring the box keeps text at its size and
// lets only the plot stretch.
function useWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => { const cw = el.clientWidth; if (cw > 0) setW(Math.max(280, Math.round(cw))) }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, w }
}

// ---------- one value per person against a limit ----------
export type BarRow = { key: string; name: string; value: number; label: string; state: VizState; tip?: string }

export function ThresholdBars({ rows, domain, limit, limitLabel, ariaLabel }: {
  rows: BarRow[]
  domain: [number, number]            // [min, max]; min < 0 draws a zero line
  limit?: number                      // omitted = no limit line (a plain readout)
  limitLabel?: string
  ariaLabel: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const { ref, w: W } = useWidth()
  if (!rows.length) return <p className="rv-empty">Nobody to show in this window</p>
  const nameW = 104, valW = 96, rowH = 24, bar = 12, padT = limitLabel ? 20 : 6
  const x0 = nameW + 8, x1 = W - valW
  const [lo, hi] = domain
  const span = hi - lo || 1
  const x = (v: number) => x0 + ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (x1 - x0)
  const zero = x(Math.max(lo, 0))
  const H = padT + rows.length * rowH + 4
  return (
    <div ref={ref}><svg className="rv-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}
      onMouseLeave={() => setHover(null)}>
      {lo < 0 && <line x1={zero} x2={zero} y1={padT - 2} y2={H - 2} stroke={VIZ.grid} strokeWidth={1} />}
      {rows.map((r, i) => {
        const y = padT + i * rowH
        const a = Math.min(zero, x(r.value)), b = Math.max(zero, x(r.value))
        const w = Math.max(r.value === 0 ? 0 : 2, b - a)
        const fill = r.state === 'flag' ? VIZ.flag : r.state === 'hit' ? HIT : r.state === 'base' ? VIZ.base : VIZ.muted
        const neg = r.value < 0
        return (
          <g key={r.key} onMouseEnter={() => setHover(r.key)}>
            <title>{r.tip || `${r.name}: ${r.label}`}</title>
            {/* the whole row is the hit target, not the painted bar */}
            <rect x={0} y={y} width={W} height={rowH} fill={hover === r.key ? '#f5f6f8' : 'transparent'} rx={4} />
            <text x={nameW} y={y + rowH / 2 + 4} textAnchor="end" className={'rv-name' + (r.state === 'flag' ? ' flag' : r.state === 'muted' ? ' muted' : '')}>
              {r.state === 'flag' ? '! ' : ''}{r.name}
            </text>
            {/* 4px rounded data-end, square at the baseline */}
            <path d={barPath(a, y + (rowH - bar) / 2, w, bar, neg)} fill={fill} />
            <text x={x1 + 8} y={y + rowH / 2 + 4} className={'rv-val' + (r.state === 'muted' ? ' muted' : '')}>{r.label}</text>
          </g>
        )
      })}
      {limit != null && (
        <g className="rv-limit">
          <line x1={x(limit)} x2={x(limit)} y1={padT - 4} y2={H - 2} stroke={VIZ.ink} strokeWidth={1.5} strokeDasharray="4 3" />
          {limitLabel && <text x={x(limit)} y={11} textAnchor="middle" className="rv-limit-l">{limitLabel}</text>}
        </g>
      )}
    </svg></div>
  )
}

function barPath(x: number, y: number, w: number, h: number, neg: boolean) {
  const r = Math.min(4, w / 2, h / 2)
  if (w <= 0) return ''
  return neg
    // rounded on the LEFT (the data end), square at the zero line
    ? `M${x + w} ${y} H${x + r} Q${x} ${y} ${x} ${y + r} V${y + h - r} Q${x} ${y + h} ${x + r} ${y + h} H${x + w} Z`
    : `M${x} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x} Z`
}

// ---------- rate as a multiple of the rest of the team ----------
export type RatioDot = { key: string; name: string; ratio: number; state: VizState; tip: string }

export function RatioStrip({ dots, low, high, ariaLabel }: {
  dots: RatioDot[]; low: number; high: number; ariaLabel: string
}) {
  const [hover, setHover] = useState<string | null>(null)
  const { ref, w: W } = useWidth()
  const H = 112, padX = 26, axisY = 64
  const lmin = Math.log(0.1), lmax = Math.log(10)
  const x = (v: number) => padX + ((Math.log(Math.min(10, Math.max(0.1, v))) - lmin) / (lmax - lmin)) * (W - padX * 2)
  // A light beeswarm: dots closer than 12px step up and down, so two people at the
  // same ratio are two dots, not one.
  const placed: Array<RatioDot & { cx: number; cy: number }> = []
  for (const d of [...dots].sort((a, b) => a.ratio - b.ratio)) {
    const cx = x(d.ratio)
    let k = 0
    while (placed.some((p) => Math.abs(p.cx - cx) < 12 && p.cy === axisY + offset(k))) k++
    placed.push({ ...d, cx, cy: axisY + offset(k) })
  }
  // Labels that would touch alternate above and below the dots, so two flagged people
  // at nearly the same ratio are two readable names, not one smudge.
  const labelBelow = new Set<string>()
  let lastX = -Infinity, lastBelow = true
  for (const p of placed.filter((q) => q.state === 'flag' || q.key === hover)) {
    const below: boolean = p.cx - lastX < 64 ? !lastBelow : false
    if (below) labelBelow.add(p.key)
    lastX = p.cx; lastBelow = below
  }
  const ticks = [0.1, 0.25, 0.5, 1, 2, 5, 10]
  return (
    <div ref={ref}><svg className="rv-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
      <rect x={padX} y={axisY - 26} width={x(low) - padX} height={52} fill={VIZ.flagWash} rx={6} />
      <rect x={x(high)} y={axisY - 26} width={W - padX - x(high)} height={52} fill={VIZ.flagWash} rx={6} />
      <text x={(padX + x(low)) / 2} y={axisY - 32} textAnchor="middle" className="rv-zone-l">too little</text>
      <text x={(x(high) + W - padX) / 2} y={axisY - 32} textAnchor="middle" className="rv-zone-l">too much</text>
      <line x1={padX} x2={W - padX} y1={axisY} y2={axisY} stroke={VIZ.grid} strokeWidth={1} />
      <line x1={x(1)} x2={x(1)} y1={axisY - 26} y2={axisY + 26} stroke={VIZ.grid} strokeWidth={1} />
      {[low, high].map((v, i) => (
        <line key={i} x1={x(v)} x2={x(v)} y1={axisY - 26} y2={axisY + 26} stroke={VIZ.ink} strokeWidth={1.5} strokeDasharray="4 3" />
      ))}
      {ticks.map((t) => (
        <text key={t} x={x(t)} y={H - 6} textAnchor="middle" className={'rv-tick' + (t === 1 ? ' strong' : '')}>
          {t === 1 ? 'same as the rest' : `${t}×`}
        </text>
      ))}
      {placed.map((p) => (
        <g key={p.key} onMouseEnter={() => setHover(p.key)} onFocus={() => setHover(p.key)} tabIndex={0}>
          <title>{p.tip}</title>
          <circle cx={p.cx} cy={p.cy} r={12} fill="transparent" />
          <circle cx={p.cx} cy={p.cy} r={5.5} fill={p.state === 'flag' ? VIZ.flag : VIZ.base} stroke="#fff" strokeWidth={2} />
          {(p.state === 'flag' || hover === p.key) && (
            <text x={p.cx} y={labelBelow.has(p.key) ? p.cy + 20 : p.cy - 10} textAnchor="middle" className={'rv-dot-l' + (p.state === 'flag' ? ' flag' : '')}>
              {p.state === 'flag' ? '! ' : ''}{p.name}
            </text>
          )}
        </g>
      ))}
    </svg></div>
  )
}
const offset = (k: number) => (k === 0 ? 0 : (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 9)

// ---------- where everyone sits, and the gap between the two ends ----------
export type SpreadDot = { key: string; name: string; value: number; tip: string }

export function SpreadLine({ dots, limit, ariaLabel }: { dots: SpreadDot[]; limit: number; ariaLabel: string }) {
  const [hover, setHover] = useState<string | null>(null)
  const { ref, w: W } = useWidth()
  if (dots.length < 2) return <p className="rv-empty">Needs two people with enough games</p>
  const H = 96, padX = 26, axisY = 58
  const x = (v: number) => padX + Math.min(1, Math.max(0, v)) * (W - padX * 2)
  const sorted = [...dots].sort((a, b) => a.value - b.value)
  const loose = sorted[0], strict = sorted[sorted.length - 1]
  const gap = strict.value - loose.value
  const over = gap > limit
  const allowEnd = Math.min(1, loose.value + limit)
  return (
    <div ref={ref}><svg className="rv-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
      {/* the spread the rule allows, measured from the loosest evaluator */}
      <rect x={x(loose.value)} y={axisY - 12} width={x(allowEnd) - x(loose.value)} height={24} fill="#eef3ff" rx={6} />
      <line x1={padX} x2={W - padX} y1={axisY} y2={axisY} stroke={VIZ.grid} strokeWidth={1} />
      <line x1={x(allowEnd)} x2={x(allowEnd)} y1={axisY - 16} y2={axisY + 16} stroke={VIZ.ink} strokeWidth={1.5} strokeDasharray="4 3" />
      {/* the gap itself, as a bracket above the two ends */}
      <path d={`M${x(loose.value)} ${axisY - 20} V${axisY - 26} H${x(strict.value)} V${axisY - 20}`}
        fill="none" stroke={over ? VIZ.flag : VIZ.base} strokeWidth={2} />
      <text x={(x(loose.value) + x(strict.value)) / 2} y={axisY - 32} textAnchor="middle" className={'rv-dot-l' + (over ? ' flag' : '')}>
        {over ? '! ' : ''}{Math.round(gap * 100)} pts apart
      </text>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <text key={t} x={x(t)} y={H - 4} textAnchor="middle" className="rv-tick">{Math.round(t * 100)}%</text>
      ))}
      {sorted.map((p) => {
        const end = p === loose || p === strict
        return (
          <g key={p.key} onMouseEnter={() => setHover(p.key)} tabIndex={0}>
            <title>{p.tip}</title>
            <circle cx={x(p.value)} cy={axisY} r={12} fill="transparent" />
            <circle cx={x(p.value)} cy={axisY} r={5.5} fill={end && over ? VIZ.flag : VIZ.base} stroke="#fff" strokeWidth={2} />
            {(end || hover === p.key) && (
              <text x={x(p.value)} y={axisY + 22} textAnchor="middle" className="rv-dot-l">{p.name}</text>
            )}
          </g>
        )
      })}
    </svg></div>
  )
}

// ---------- one team number against its limit ----------
export function Meter({ value, limit, max, format, ariaLabel }: {
  value: number; limit: number; max: number; format: (v: number) => string; ariaLabel: string
}) {
  const over = value > limit
  const pct = (v: number) => `${(Math.min(max, Math.max(0, v)) / max) * 100}%`
  return (
    <div className="rv-meter" role="img" aria-label={ariaLabel}>
      <div className="rv-meter-track">
        <div className="rv-meter-fill" style={{ width: pct(value), background: over ? VIZ.flag : '#2a78d6' }} />
        <div className="rv-meter-limit" style={{ left: pct(limit) }}><span>limit {format(limit)}</span></div>
      </div>
      <div className="rv-meter-read">
        <b>{format(value)}</b> {over ? <span className="rv-over">! over the limit</span> : <span className="rv-under">under the limit</span>}
      </div>
    </div>
  )
}

// ---------- the control: slider for the common range, box for the exact number ----------
export function RuleControl({ label, value, onChange, slider, bounds, unit, def, fmtDef }: {
  label: string
  value: number                                  // in DISPLAY units
  onChange: (v: number) => void
  slider: { min: number; max: number; step: number }
  bounds: { min: number; max: number }
  unit: string
  def: number
  fmtDef: string
}) {
  const changed = value !== def
  return (
    <div className={'rv-ctl' + (changed ? ' changed' : '')}>
      <input type="range" aria-label={`${label} slider`} min={slider.min} max={slider.max} step={slider.step}
        value={Math.min(slider.max, Math.max(slider.min, value))} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="rv-ctl-box">
        <input type="number" aria-label={label} value={value} min={bounds.min} max={bounds.max} step={slider.step}
          onChange={(e) => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v)) onChange(v) }}
          onBlur={() => onChange(Math.min(bounds.max, Math.max(bounds.min, value)))} />
        <span className="rv-ctl-unit">{unit}</span>
      </span>
      {changed
        ? <button type="button" className="rv-ctl-def" onClick={() => onChange(def)} title="Back to the default">default {fmtDef} ↺</button>
        : <span className="rv-ctl-def is">default</span>}
    </div>
  )
}

// One rule: what it is, its control(s), the live picture, and what it would flag now.
export function RuleBlock({ id, title, where, what, controls, children, verdict, tone }: {
  id?: string; title: string; where: string; what: ReactNode
  controls: ReactNode; children: ReactNode; verdict: ReactNode; tone: 'flag' | 'ok' | 'none'
}) {
  return (
    <div className="rv-rule" id={id}>
      <div className="rv-rule-head">
        <div>
          <div className="rv-rule-title">{title}</div>
          <div className="rv-rule-what">{what}</div>
        </div>
        <span className="rv-rule-where">{where}</span>
      </div>
      <div className="rv-rule-ctls">{controls}</div>
      <div className="rv-rule-viz">{children}</div>
      <div className={'rv-rule-verdict ' + tone}>
        <span className="rv-rule-verdict-i">{tone === 'flag' ? '!' : tone === 'ok' ? '✓' : '·'}</span>
        <span>{verdict}</span>
      </div>
    </div>
  )
}
