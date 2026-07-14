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
export function ColumnChart({ data, height = 200, color = CAT[0] }: {
  data: Array<{ label: string; value: number; sub?: string }>; height?: number; color?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (data.length === 0) return <Empty />
  const max = Math.max(1, ...data.map((d) => d.value))
  const W = Math.max(data.length * 26, 300), H = height, pad = 24
  const bw = (W - pad) / data.length
  const barW = Math.min(28, bw * 0.62)
  // Thin out x labels when crowded.
  const step = Math.ceil(data.length / 14)
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <line key={g} x1={0} x2={W} y1={(H - pad) * (1 - g)} y2={(H - pad) * (1 - g)} className="rp-grid" />
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * (H - pad - 8)
          const x = pad + i * bw + (bw - barW) / 2
          const y = (H - pad) - h
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H - pad} fill="transparent" />
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)} rx={3}
                fill={color} opacity={hover == null || hover === i ? 1 : 0.5} />
              {i % step === 0 && (
                <text x={pad + i * bw + bw / 2} y={H - pad + 14} className="rp-xlabel">{d.label}</text>
              )}
            </g>
          )
        })}
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${((pad + hover * bw + bw / 2) / W) * 100}%` }}>
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
