'use client'
// Hand-rolled SVG/CSS chart primitives for the Report tab. No chart library — keeps
// the bundle small and matches the app's existing inline-SVG style. Palette is the
// dataviz-validated categorical set; conclusion hues reuse the app's badge intent.

import { useState } from 'react'

// Validated categorical palette (see scripts/validate_palette.js). Assigned in fixed
// order, never cycled past 8 — a 9th series folds into "Other" upstream.
export const CAT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']

// Semantic colors per conclusion / record bucket. Falls back to the categorical
// ramp for anything unmapped so new config values still render distinctly.
const CONCLUSION_COLORS: Record<string, string> = {
  'Priority V': '#6d28d9', 'Priority IV': '#0f766e', 'Priority III': '#0891b2',
  'Priority II': '#0ea5e9', 'Priority I': '#38bdf8',
  'Bypass': '#d23b3b', 'Playtest & Bypass': '#b45309',
  'Theme/Art': '#2563eb', 'Insight': '#15803d', 'Watch List': '#16a34a',
  'List_Idea': '#7c3aed', 'Not Found': '#374151',
  '5min': '#2a78d6', '20min': '#eb6834', 'none': '#9ca3af',
}
export function conclusionColor(name: string, i = 0): string {
  return CONCLUSION_COLORS[name] || CAT[i % CAT.length]
}

export const fmt = {
  int: (n: number) => Math.round(n).toLocaleString('en-US'),
  dec: (n: number, d = 1) => n.toFixed(d),
  pct: (n: number) => `${Math.round(n * 100)}%`,
  days: (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}d`),
  signed: (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`),
}

// ---------- KPI card ----------
export function Kpi({ label, value, sub, trend, hi }: {
  label: string; value: string; sub?: string; trend?: number | null; hi?: boolean
}) {
  const tclass = trend == null ? '' : trend > 0 ? 'up' : trend < 0 ? 'down' : ''
  return (
    <div className={'rp-kpi' + (hi ? ' hi' : '')}>
      <div className="rp-kpi-label">{label}</div>
      <div className="rp-kpi-value">{value}</div>
      <div className="rp-kpi-sub">
        {sub}
        {trend != null && <span className={'rp-trend ' + tclass}>{fmt.signed(trend)}</span>}
      </div>
    </div>
  )
}

// ---------- vertical column chart over time (volume) ----------
// Fixed viewBox so labels/bars stay a sensible size regardless of point count.
export function ColumnChart({ data, color = CAT[0] }: {
  data: Array<{ label: string; value: number; sub?: string }>; color?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (data.length === 0) return <Empty />
  const max = Math.max(1, ...data.map((d) => d.value))
  const VW = 1000, VH = 250, padX = 12, padB = 30, padT = 20
  const innerW = VW - padX * 2, innerH = VH - padB - padT
  const slot = innerW / data.length
  const barW = Math.min(58, slot * 0.6)
  const n = data.length
  const step = Math.ceil(n / 16)
  const showVals = n <= 16
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1={padX} x2={VW - padX} y1={padT + innerH * (1 - g)} y2={padT + innerH * (1 - g)} className="rp-grid" />
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * innerH
          const cx = padX + i * slot + slot / 2
          const x = cx - barW / 2
          const y = padT + innerH - h
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padX + i * slot} y={padT} width={slot} height={innerH} fill="transparent" />
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)} rx={4}
                fill={color} opacity={hover == null || hover === i ? 1 : 0.45} />
              {showVals && <text x={cx} y={y - 5} className="rp-barval">{fmt.int(d.value)}</text>}
              {i % step === 0 && <text x={cx} y={VH - 10} className="rp-xlabel">{d.label}</text>}
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${((padX + hover * slot + slot / 2) / VW) * 100}%` }}>
          <b>{data[hover].label}</b><br />{fmt.int(data[hover].value)}{data[hover].sub ? ` · ${data[hover].sub}` : ''}
        </div>
      )}
    </div>
  )
}

// ---------- horizontal ranked bars ----------
export function RankBars({ rows, unit, color = CAT[0], format }: {
  rows: Array<{ name: string; value: number }>; unit?: string; color?: string
  format?: (v: number) => string
}) {
  if (rows.length === 0) return <Empty />
  const max = Math.max(1, ...rows.map((r) => r.value))
  const f = format || fmt.int
  return (
    <div className="rp-rank">
      {rows.map((r, i) => (
        <div className="rp-rank-row" key={r.name}>
          <span className="rp-rank-i">{i + 1}</span>
          <span className="rp-rank-name" title={r.name}>{r.name}</span>
          <span className="rp-rank-track">
            <span className="rp-rank-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </span>
          <span className="rp-rank-val">{f(r.value)}{unit ? <span className="rp-unit"> {unit}</span> : null}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- donut with legend ----------
export function Donut({ data, size = 180 }: {
  data: Array<{ name: string; count: number }>; size?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const total = data.reduce((s, d) => s + d.count, 0)
  if (total === 0) return <Empty />
  const r = size / 2, ir = r * 0.62, cx = r, cy = r
  let acc = 0
  const arcs = data.map((d, i) => {
    const a0 = (acc / total) * 2 * Math.PI - Math.PI / 2
    acc += d.count
    const a1 = (acc / total) * 2 * Math.PI - Math.PI / 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const p = (ang: number, rad: number) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)]
    const [x0, y0] = p(a0, r), [x1, y1] = p(a1, r), [x2, y2] = p(a1, ir), [x3, y3] = p(a0, ir)
    return { i, d, path: `M${x0} ${y0} A${r} ${r} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${ir} ${ir} 0 ${large} 0 ${x3} ${y3} Z` }
  })
  return (
    <div className="rp-donut-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} onMouseLeave={() => setHover(null)}>
        {arcs.map((a) => (
          <path key={a.i} d={a.path} fill={conclusionColor(a.d.name, a.i)} stroke="var(--surface)" strokeWidth={2}
            opacity={hover == null || hover === a.i ? 1 : 0.45} onMouseEnter={() => setHover(a.i)} />
        ))}
        <text x={cx} y={cy - 4} className="rp-donut-num">{fmt.int(hover == null ? total : data[hover].count)}</text>
        <text x={cx} y={cy + 14} className="rp-donut-cap">{hover == null ? 'total' : `${Math.round((data[hover].count / total) * 100)}%`}</text>
      </svg>
      <div className="rp-legend">
        {data.map((d, i) => (
          <div className="rp-legend-row" key={d.name} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="rp-dot" style={{ background: conclusionColor(d.name, i) }} />
            <span className="rp-legend-name">{d.name}</span>
            <span className="rp-legend-val">{fmt.int(d.count)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- heatmap (person × period) ----------
export function Heatmap({ periods, rows }: {
  periods: Array<{ key: string; label: string }>
  rows: Array<{ name: string; cells: Record<string, number> }>
}) {
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null)
  if (rows.length === 0 || periods.length === 0) return <Empty />
  const max = Math.max(1, ...rows.flatMap((r) => Object.values(r.cells)))
  const shade = (v: number) => {
    if (!v) return 'var(--surface-2)'
    const t = 0.18 + 0.82 * (v / max)
    return `color-mix(in srgb, ${CAT[0]} ${Math.round(t * 100)}%, var(--surface))`
  }
  return (
    <div className="rp-heat-scroll">
      <div className="rp-heat" style={{ gridTemplateColumns: `120px repeat(${periods.length}, 30px)` }}>
        <div />
        {periods.map((p) => <div key={p.key} className="rp-heat-col" title={p.label}>{p.label.replace(/ \d{4}$/, '')}</div>)}
        {rows.map((row, ri) => (
          <FragmentRow key={row.name}>
            <div className="rp-heat-name" title={row.name}>{row.name}</div>
            {periods.map((p, ci) => {
              const v = row.cells[p.key] || 0
              return (
                <div key={p.key} className="rp-heat-cell" style={{ background: shade(v) }}
                  onMouseEnter={() => setHover({ r: ri, c: ci })} onMouseLeave={() => setHover(null)}>
                  {hover && hover.r === ri && hover.c === ci && (
                    <span className="rp-heat-tip">{row.name} · {p.label}: <b>{v}</b></span>
                  )}
                </div>
              )
            })}
          </FragmentRow>
        ))}
      </div>
    </div>
  )
}

// grid children must be flat, so this just returns its children (keyed by parent).
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function Empty({ text = 'No data' }: { text?: string }) {
  return <div className="rp-empty">{text}</div>
}

// ---------- funnel (decreasing stages + conversion %) ----------
export function Funnel({ stages }: {
  stages: Array<{ label: string; value: number; hint?: string }>
}) {
  if (stages.length === 0 || stages[0].value === 0) return <Empty />
  const top = stages[0].value
  // sequential blue ramp, dark→light down the funnel
  const shade = (i: number) => `color-mix(in srgb, ${CAT[0]} ${Math.round(100 - i * 14)}%, #ffffff)`
  return (
    <div className="rp-funnel">
      {stages.map((s, i) => {
        const pctOfTop = (s.value / top) * 100
        const prev = i > 0 ? stages[i - 1].value : null
        const conv = prev && prev > 0 ? (s.value / prev) * 100 : null
        return (
          <div className="rp-funnel-row" key={s.label}>
            <div className="rp-funnel-head">
              <span className="rp-funnel-label">{s.label}</span>
              <span className="rp-funnel-val">{fmt.int(s.value)}
                <span className="rp-funnel-pct"> · {Math.round(pctOfTop)}% of top</span>
              </span>
            </div>
            <div className="rp-funnel-bar-track">
              <div className="rp-funnel-bar" style={{ width: `${Math.max(pctOfTop, 1.5)}%`, background: shade(i) }} />
            </div>
            {conv != null && i > 0 && (
              <div className="rp-funnel-conv">↳ {Math.round(conv)}% converted from {stages[i - 1].label}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------- radar (N axes, one or more overlaid series) ----------
export function Radar({ axes, series, size = 240 }: {
  axes: string[]
  series: Array<{ name: string; values: number[]; color?: string }> // values 0..100 aligned to axes
  size?: number
}) {
  const [hi, setHi] = useState<number | null>(null)
  if (axes.length < 3) return <Empty />
  const cx = size / 2, cy = size / 2, R = size / 2 - 46
  const ang = (i: number) => (i / axes.length) * 2 * Math.PI - Math.PI / 2
  const pt = (i: number, r: number) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))]
  const rings = [0.25, 0.5, 0.75, 1]
  return (
    <div className="rp-radar-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
        {/* grid rings */}
        {rings.map((g) => (
          <polygon key={g} className="rp-radar-grid"
            points={axes.map((_, i) => pt(i, R * g).join(',')).join(' ')} />
        ))}
        {/* spokes + labels */}
        {axes.map((a, i) => {
          const [x, y] = pt(i, R)
          const [lx, ly] = pt(i, R + 16)
          return (
            <g key={a}>
              <line className="rp-radar-spoke" x1={cx} y1={cy} x2={x} y2={y} />
              <text x={lx} y={ly} className="rp-radar-axis"
                textAnchor={Math.abs(lx - cx) < 6 ? 'middle' : lx > cx ? 'start' : 'end'}
                dominantBaseline={Math.abs(ly - cy) < 6 ? 'middle' : ly > cy ? 'hanging' : 'auto'}>{a}</text>
            </g>
          )
        })}
        {/* series polygons */}
        {series.map((s, si) => {
          const color = s.color || CAT[si % CAT.length]
          const dim = hi != null && hi !== si
          const poly = s.values.map((v, i) => pt(i, R * Math.max(0, Math.min(100, v)) / 100).join(',')).join(' ')
          return (
            <g key={s.name} opacity={dim ? 0.12 : 1}>
              <polygon points={poly} fill={color} fillOpacity={series.length > 1 ? 0.08 : 0.16} stroke={color} strokeWidth={2} />
              {s.values.map((v, i) => { const [x, y] = pt(i, R * Math.max(0, Math.min(100, v)) / 100); return <circle key={i} cx={x} cy={y} r={3} fill={color} /> })}
            </g>
          )
        })}
      </svg>
      {series.length > 1 && (
        <div className="rp-legend">
          {series.map((s, si) => (
            <div className="rp-legend-row" key={s.name} onMouseEnter={() => setHi(si)} onMouseLeave={() => setHi(null)}>
              <span className="rp-dot" style={{ background: s.color || CAT[si % CAT.length] }} />
              <span className="rp-legend-name">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- team health bars (green/amber/red thresholds) ----------
export function HealthBars({ rows }: {
  rows: Array<{ label: string; value: string; pct: number; status: 'good' | 'warn' | 'bad' }>
}) {
  const col = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' }
  return (
    <div className="rp-health">
      {rows.map((r) => (
        <div className="rp-health-row" key={r.label}>
          <div className="rp-health-top">
            <span className="rp-health-label">{r.label}</span>
            <span className="rp-health-val" style={{ color: col[r.status] }}>{r.value}</span>
          </div>
          <div className="rp-health-track">
            <div className="rp-health-fill" style={{ width: `${Math.max(2, Math.min(100, r.pct))}%`, background: col[r.status] }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- stacked conclusion bars per evaluator ----------
export function StackedBars({ rows, keys }: {
  rows: Array<{ name: string; parts: Record<string, number> }>
  keys: string[] // conclusion names in stack order
}) {
  const [hover, setHover] = useState<string | null>(null)
  if (rows.length === 0) return <Empty />
  const totals = rows.map((r) => keys.reduce((s, k) => s + (r.parts[k] || 0), 0))
  const max = Math.max(1, ...totals)
  return (
    <div>
      <div className="rp-legend rp-legend-horiz">
        {keys.map((k, i) => (
          <div className="rp-legend-row" key={k} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <span className="rp-dot" style={{ background: conclusionColor(k, i) }} /><span className="rp-legend-name">{k}</span>
          </div>
        ))}
      </div>
      <div className="rp-stack">
        {rows.map((r, ri) => (
          <div className="rp-stack-row" key={r.name}>
            <span className="rp-stack-name" title={r.name}>{r.name}</span>
            <span className="rp-stack-track">
              {keys.map((k, i) => {
                const v = r.parts[k] || 0
                if (!v) return null
                return <span key={k} className="rp-stack-seg" title={`${r.name} · ${k}: ${v}`}
                  style={{ width: `${(v / max) * 100}%`, background: conclusionColor(k, i), opacity: hover && hover !== k ? 0.3 : 1 }} />
              })}
            </span>
            <span className="rp-stack-total">{fmt.int(totals[ri])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
