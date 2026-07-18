'use client'
// Hand-rolled SVG/CSS chart primitives for the Report tab. No chart library — keeps
// the bundle small and matches the app's existing inline-SVG style. Palette is the
// dataviz-validated categorical set; conclusion hues reuse the app's badge intent.

import { useId, useState } from 'react'

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
  'List_Idea': '#7c3aed', 'Not Found': '#374151', 'Link_dead': '#9ca3af',
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

// ---------- KPI card (optional inline sparkline) ----------
export function Kpi({ label, value, sub, trend, hi, spark, sparkColor }: {
  label: string; value: string; sub?: string; trend?: number | null; hi?: boolean
  spark?: number[]; sparkColor?: string
}) {
  const tclass = trend == null ? '' : trend > 0 ? 'up' : trend < 0 ? 'down' : ''
  // derive a trend from the sparkline tail if none was supplied
  let autoTrend = trend
  if (autoTrend == null && spark && spark.length >= 2) {
    const a = spark[spark.length - 2], b = spark[spark.length - 1]
    if (a > 0) autoTrend = (b - a) / a
  }
  const at = autoTrend == null ? '' : autoTrend > 0.001 ? 'up' : autoTrend < -0.001 ? 'down' : ''
  const col = sparkColor || (hi ? 'var(--accent-strong)' : 'var(--accent)')
  return (
    <div className={'rp-kpi' + (hi ? ' hi' : '')}>
      <div className="rp-kpi-label">{label}</div>
      <div className="rp-kpi-main">
        <div className="rp-kpi-value">{value}</div>
        {spark && spark.length >= 2 && <Sparkline data={spark} color={col} />}
      </div>
      <div className="rp-kpi-sub">
        {sub}
        {trend != null
          ? <span className={'rp-trend ' + tclass}>{fmt.signed(trend)}</span>
          : autoTrend != null && at && <span className={'rp-trend ' + at}>{fmt.signed(autoTrend)}</span>}
      </div>
    </div>
  )
}

// ---------- sparkline (tiny inline trend, area-filled) ----------
export function Sparkline({ data, color = CAT[0], w = 76, h = 30 }: {
  data: number[]; color?: string; w?: number; h?: number
}) {
  const uid = useId().replace(/:/g, '')
  if (data.length < 2) return null
  const max = Math.max(...data), min = Math.min(...data)
  const span = max - min || 1
  const pad = 3
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2)
  const y = (v: number) => pad + (1 - (v - min) / span) * (h - pad * 2)
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(data.length - 1).toFixed(1)} ${h - pad} L${x(0).toFixed(1)} ${h - pad} Z`
  const gid = 'sp-' + uid
  return (
    <svg className="rp-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={2.4} fill={color} />
    </svg>
  )
}

// ---------- multi-series line / area chart over time ----------
export function LineChart({ series, area = false, format }: {
  series: Array<{ name: string; color?: string; points: Array<{ label: string; value: number }> }>
  area?: boolean; format?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')
  const n = series[0]?.points.length || 0
  if (n === 0) return <Empty />
  const f = format || fmt.int
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value)))
  const VW = 1000, VH = 260, padX = 40, padB = 30, padT = 16
  const innerW = VW - padX - 12, innerH = VH - padB - padT
  const x = (i: number) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padT + innerH * (1 - v / max)
  const labels = series[0].points.map((p) => p.label)
  const step = Math.ceil(n / 12)
  const ticks = [0, 0.25, 0.5, 0.75, 1]
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {ticks.map((g) => (
          <g key={g}>
            <line x1={padX} x2={VW - 12} y1={padT + innerH * (1 - g)} y2={padT + innerH * (1 - g)} className="rp-grid" />
            <text x={padX - 8} y={padT + innerH * (1 - g) + 4} className="rp-ylabel">{f(max * g)}</text>
          </g>
        ))}
        {area && series.map((s, si) => {
          const color = s.color || CAT[si % CAT.length]
          const gid = `lg-${uid}-${si}`
          const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
          const fill = `${path} L${x(n - 1).toFixed(1)} ${padT + innerH} L${x(0).toFixed(1)} ${padT + innerH} Z`
          return (
            <g key={s.name}>
              <defs>
                <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={fill} fill={`url(#${gid})`} />
            </g>
          )
        })}
        {series.map((s, si) => {
          const color = s.color || CAT[si % CAT.length]
          const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
          return (
            <g key={s.name}>
              <path d={path} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round" />
              {n <= 24 && s.points.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(p.value)} r={hover === i ? 4 : 2.6} fill={color}
                  opacity={hover == null || hover === i ? 1 : 0.5} />
              ))}
            </g>
          )
        })}
        {labels.map((l, i) => i % step === 0 && (
          <text key={i} x={x(i)} y={VH - 10} className="rp-xlabel">{l}</text>
        ))}
        {/* hover hit-areas */}
        {labels.map((_, i) => (
          <rect key={i} x={x(i) - innerW / (2 * Math.max(1, n - 1))} y={padT}
            width={innerW / Math.max(1, n - 1)} height={innerH} fill="transparent"
            onMouseEnter={() => setHover(i)} />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} className="rp-cursor" />}
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${(x(hover) / VW) * 100}%` }}>
          <b>{labels[hover]}</b>
          {series.map((s, si) => (
            <div key={s.name} className="rp-tip-row">
              <span className="rp-dot" style={{ background: s.color || CAT[si % CAT.length] }} />
              {s.name}: <b>{f(s.points[hover].value)}</b>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="rp-legend rp-legend-horiz" style={{ marginTop: 6, marginBottom: 0 }}>
          {series.map((s, si) => (
            <div className="rp-legend-row" key={s.name}>
              <span className="rp-dot" style={{ background: s.color || CAT[si % CAT.length] }} />
              <span className="rp-legend-name">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- scatter / quadrant ----------
export function Scatter({ points, xLabel, yLabel, xFormat, yFormat }: {
  points: Array<{ name: string; x: number; y: number; size?: number; color?: string }>
  xLabel: string; yLabel: string; xFormat?: (v: number) => string; yFormat?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return <Empty />
  const xf = xFormat || fmt.dec, yf = yFormat || fmt.int
  const VW = 640, VH = 420, padL = 46, padB = 40, padT = 14, padR = 14
  const innerW = VW - padL - padR, innerH = VH - padB - padT
  const maxX = Math.max(1, ...points.map((p) => p.x)) * 1.08
  const maxY = Math.max(1, ...points.map((p) => p.y)) * 1.08
  const meanX = points.reduce((s, p) => s + p.x, 0) / points.length
  const meanY = points.reduce((s, p) => s + p.y, 0) / points.length
  const maxSize = Math.max(1, ...points.map((p) => p.size || 1))
  const px = (v: number) => padL + (v / maxX) * innerW
  const py = (v: number) => padT + innerH * (1 - v / maxY)
  const rad = (s?: number) => 5 + Math.sqrt((s || 1) / maxSize) * 13
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <g key={g}>
            <line x1={padL} x2={VW - padR} y1={padT + innerH * g} y2={padT + innerH * g} className="rp-grid" />
            <text x={padL - 8} y={padT + innerH * g + 4} className="rp-ylabel">{yf(maxY * (1 - g))}</text>
          </g>
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map((g) => (
          <text key={g} x={padL + innerW * g} y={VH - 12} className="rp-xlabel">{xf(maxX * g)}</text>
        ))}
        {/* mean quadrant lines */}
        <line x1={px(meanX)} x2={px(meanX)} y1={padT} y2={padT + innerH} className="rp-quad" />
        <line x1={padL} x2={VW - padR} y1={py(meanY)} y2={py(meanY)} className="rp-quad" />
        <text x={px(meanX) + 4} y={padT + 10} className="rp-quad-lbl">avg {xLabel}</text>
        <text x={padL + 4} y={py(meanY) - 4} className="rp-quad-lbl">avg {yLabel}</text>
        {points.map((p, i) => (
          <g key={p.name} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={px(p.x)} cy={py(p.y)} r={rad(p.size)} fill={p.color || CAT[i % CAT.length]}
              fillOpacity={hover == null || hover === i ? 0.62 : 0.18} stroke={p.color || CAT[i % CAT.length]}
              strokeWidth={hover === i ? 2 : 1} />
            {(hover === i || points.length <= 12) && (
              <text x={px(p.x)} y={py(p.y) - rad(p.size) - 3} className="rp-scatter-lbl" textAnchor="middle">{p.name}</text>
            )}
          </g>
        ))}
        <text x={padL + innerW / 2} y={VH - 1} className="rp-axis-title" textAnchor="middle">{xLabel} →</text>
        <text x={-(padT + innerH / 2)} y={12} className="rp-axis-title" textAnchor="middle" transform="rotate(-90)">{yLabel} →</text>
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${(px(points[hover].x) / VW) * 100}%` }}>
          <b>{points[hover].name}</b><br />
          {xLabel}: {xf(points[hover].x)}<br />{yLabel}: {yf(points[hover].y)}
          {points[hover].size != null && <><br />vol: {fmt.int(points[hover].size!)}</>}
        </div>
      )}
    </div>
  )
}

// ---------- bump chart (rank position over periods) ----------
export function BumpChart({ periods, rows, topN = 8 }: {
  periods: Array<{ key: string; label: string }>
  rows: Array<{ name: string; cells: Record<string, number> }>
  topN?: number
}) {
  const [hi, setHi] = useState<string | null>(null)
  if (periods.length < 2 || rows.length === 0) return <Empty text="Need at least two periods to rank" />
  // per period, rank people by value (desc). rank 1 = best. missing = no rank that period.
  const ranks: Record<string, Record<string, number>> = {}
  for (const p of periods) {
    const present = rows.filter((r) => (r.cells[p.key] || 0) > 0)
      .sort((a, b) => (b.cells[p.key] || 0) - (a.cells[p.key] || 0))
    present.forEach((r, i) => { (ranks[r.name] ||= {})[p.key] = i + 1 })
  }
  // keep people who reach topN in at least one period
  const keep = rows.filter((r) => periods.some((p) => (ranks[r.name]?.[p.key] || 99) <= topN))
    .sort((a, b) => (ranks[a.name]?.[periods[periods.length - 1].key] || 99) - (ranks[b.name]?.[periods[periods.length - 1].key] || 99))
  if (keep.length === 0) return <Empty />
  const rowsShown = Math.min(topN, keep.length)
  const VW = 1000, rowH = 30, padT = 14, padB = 26, padL = 130, padR = 130
  const VH = padT + padB + rowH * (rowsShown - 1)
  const innerW = VW - padL - padR
  const x = (i: number) => padL + (periods.length === 1 ? innerW / 2 : (i / (periods.length - 1)) * innerW)
  const y = (rank: number) => padT + (rank - 1) * rowH
  const step = Math.ceil(periods.length / 12)
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHi(null)}>
        {Array.from({ length: rowsShown }, (_, r) => (
          <text key={r} x={padL - 24} y={y(r + 1) + 4} className="rp-bump-rank">{r + 1}</text>
        ))}
        {periods.map((p, i) => i % step === 0 && (
          <text key={p.key} x={x(i)} y={VH - 8} className="rp-xlabel">{p.label}</text>
        ))}
        {keep.map((r, ci) => {
          const color = CAT[ci % CAT.length]
          const dim = hi != null && hi !== r.name
          const seg: string[] = []
          const dots: Array<[number, number]> = []
          let started = false
          periods.forEach((p, i) => {
            const rk = ranks[r.name]?.[p.key]
            if (rk && rk <= topN) {
              seg.push(`${started ? 'L' : 'M'}${x(i).toFixed(1)} ${y(rk).toFixed(1)}`)
              dots.push([x(i), y(rk)])
              started = true
            } else { started = false }
          })
          const last = keep.length && ranks[r.name]?.[periods[periods.length - 1].key]
          const first = ranks[r.name]?.[periods.find((p) => ranks[r.name]?.[p.key])?.key || '']
          return (
            <g key={r.name} opacity={dim ? 0.15 : 1} onMouseEnter={() => setHi(r.name)}
              onMouseLeave={() => setHi(null)} style={{ cursor: 'default' }}>
              <path d={seg.join(' ')} fill="none" stroke={color} strokeWidth={dim ? 2 : 3}
                strokeLinejoin="round" strokeLinecap="round" />
              {dots.map(([cx, cy], k) => <circle key={k} cx={cx} cy={cy} r={4} fill={color} stroke="var(--surface)" strokeWidth={1.5} />)}
              {first && <text x={x(periods.findIndex((p) => ranks[r.name]?.[p.key])) - 8} y={y(first) + 4}
                className="rp-bump-name" textAnchor="end">{r.name}</text>}
              {last && last <= topN && <text x={x(periods.length - 1) + 8} y={y(last) + 4}
                className="rp-bump-name" textAnchor="start">{r.name}</text>}
            </g>
          )
        })}
      </svg>
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
