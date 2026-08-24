'use client'
// Hand-rolled SVG/CSS chart primitives for the Report tab. No chart library - keeps
// the bundle small and matches the app's existing inline-SVG style. Palette is the
// dataviz-validated categorical set; conclusion hues reuse the app's badge intent.

import { useId, useRef, useState, type ReactNode } from 'react'

// Validated categorical palette (see scripts/validate_palette.js). Assigned in fixed
// order, never cycled past 8 - a 9th series folds into "Other" upstream.
export const CAT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']

// Semantic colors per conclusion / record bucket. Falls back to the categorical
// ramp for anything unmapped so new config values still render distinctly.
const CONCLUSION_COLORS: Record<string, string> = {
  'Priority V': '#6d28d9', 'Priority IV': '#0f766e', 'Priority III': '#0891b2',
  'Priority II': '#0ea5e9', 'Priority I': '#38bdf8',
  'Bypass': '#d23b3b', 'Playtest & Bypass': '#b45309',
  'Theme/Art': '#2563eb', 'Insight': '#15803d', 'Watch List': '#16a34a',
  'List_Idea': '#7c3aed', 'Not Found': '#374151', 'Link_dead': '#9ca3af',
  'Stale_release': '#9ca3af',
  '5min': '#2a78d6', '20min': '#eb6834', 'none': '#9ca3af',
}
export function conclusionColor(name: string, i = 0): string {
  return CONCLUSION_COLORS[name] || CAT[i % CAT.length]
}

export const fmt = {
  int: (n: number) => Math.round(n).toLocaleString('en-US'),
  dec: (n: number, d = 1) => n.toFixed(d),
  // sub-1% rates keep a decimal so they don't collapse to "0%" / "1%"
  pct: (n: number) => { const p = n * 100; return p > 0 && p < 2 ? `${p.toFixed(1)}%` : `${Math.round(p)}%` },
  days: (n: number | null) => (n == null ? '-' : `${n.toFixed(1)}d`),
  signed: (n: number | null) => (n == null ? '-' : `${n > 0 ? '+' : ''}${Math.round(n * 100)}%`),
}

// Axis scale with round gridline values: pick a 1/2/2.5/5 x 10^k step so ticks land
// on numbers a human reads at a glance (0 · 250 · 500 …) instead of fractions of the
// raw maximum (0 · 6.7% · 13.3% …).
export function niceScale(rawMax: number, tickCount = 4): { max: number; ticks: number[] } {
  if (!isFinite(rawMax) || rawMax <= 0) return { max: 1, ticks: [0, 1] }
  const raw = rawMax / tickCount
  const base = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / base
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * base
  const max = step * tickCount
  return { max, ticks: Array.from({ length: tickCount + 1 }, (_, i) => i * step) }
}

// ---------- "?" tooltip: metric definition + how to act on it ----------
// The popover is position:fixed and placed from the icon's viewport rect, clamped
// to the viewport - it can never be clipped by card/grid boundaries.
export function InfoTip({ title, children }: { title?: string; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const W = 270
    const x = Math.min(Math.max(8, r.left + r.width / 2 - W / 2), window.innerWidth - W - 8)
    setPos({ x, y: r.bottom + 7 })
  }
  return (
    <span className="rp-qtip" ref={ref} onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      <span className="rp-qtip-icon" aria-label="What is this?">?</span>
      {pos && (
        <span className="rp-qtip-pop" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {title && <span className="rp-qtip-title">{title}</span>}
          {children}
        </span>
      )}
    </span>
  )
}

// ---------- data-driven insight callout (colored strip under a chart) ----------
export function Insight({ level = 'info', children }: { level?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  return <div className={`rp-insight rp-insight-${level}`}>{children}</div>
}

// ---------- KPI card (optional inline sparkline) ----------
// A benchmark line under a KPI: what the team does on the same metric, and how far
// this value sits from it. `tone` is passed in because "better" is metric-specific
// (higher throughput is good, higher turnaround is not).
export type Bench = { text: string; delta: number | null; tone: 'good' | 'bad' | 'flat' }

export function Kpi({ label, value, sub, trend, hi, spark, sparkColor, tip, bench }: {
  label: string; value: string; sub?: string; trend?: number | null; hi?: boolean
  spark?: number[]; sparkColor?: string; tip?: ReactNode; bench?: Bench | null
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
      <div className="rp-kpi-label">{label}{tip && <InfoTip title={label}>{tip}</InfoTip>}</div>
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
      {bench && (
        <div className="rp-kpi-bench">
          <span>{bench.text}</span>
          {bench.delta != null && <span className={'rp-bench-delta ' + bench.tone}>{fmt.signed(bench.delta)}</span>}
        </div>
      )}
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
export function LineChart({ series, area = false, format, rightLabel, rightFormat }: {
  // a series marked axis:'right' is scaled to its own maximum, so a small-magnitude
  // line (e.g. headcount) stays readable next to a large one (e.g. game counts)
  series: Array<{ name: string; color?: string; axis?: 'left' | 'right'; dashed?: boolean; points: Array<{ label: string; value: number }> }>
  area?: boolean; format?: (v: number) => string
  rightLabel?: string; rightFormat?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')
  const n = series[0]?.points.length || 0
  if (n === 0) return <Empty />
  const f = format || fmt.int
  const fr = rightFormat || f
  const isRight = (s: { axis?: 'left' | 'right' }) => s.axis === 'right'
  const hasRight = series.some(isRight)
  const left = niceScale(Math.max(1, ...series.filter((s) => !isRight(s)).flatMap((s) => s.points.map((p) => p.value))))
  const right = niceScale(Math.max(1, ...series.filter(isRight).flatMap((s) => s.points.map((p) => p.value))))
  const max = left.max, maxR = right.max
  const VW = 1000, VH = 260, padX = 40, padB = 30, padT = 22
  const innerW = VW - padX - (hasRight ? 46 : 12), innerH = VH - padB - padT
  const x = (i: number) => padX + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => padT + innerH * (1 - v / max)
  const yR = (v: number) => padT + innerH * (1 - v / maxR)
  const yOf = (s: { axis?: 'left' | 'right' }, v: number) => (isRight(s) ? yR(v) : y(v))
  const labels = series[0].points.map((p) => p.label)
  const step = Math.ceil(n / 12)
  // Point values are printed next to their dot only when the chart is sparse enough
  // to stay readable; denser charts keep the hover tooltip. Series that land on top
  // of each other (all the low lines bunched near zero) are pushed apart vertically,
  // so a label always belongs to exactly one visible dot.
  const showValues = n <= 8 && series.length <= 4
  const MIN_GAP = 14
  const labelY: number[][] = series.map(() => [])
  if (showValues) {
    for (let i = 0; i < n; i++) {
      const order = series
        .map((s, si) => ({ si, y: yOf(s, s.points[i].value) }))
        .sort((a, b) => b.y - a.y) // bottom-most first, push upward from there
      let floor = Infinity
      for (const o of order) {
        const wanted = Math.min(o.y - 9, floor - MIN_GAP)
        labelY[o.si][i] = Math.max(wanted, padT - 6)
        floor = labelY[o.si][i]
      }
    }
  }
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {left.ticks.map((tv, ti) => (
          <g key={tv}>
            <line x1={padX} x2={padX + innerW} y1={y(tv)} y2={y(tv)} className="rp-grid" />
            <text x={padX - 8} y={y(tv) + 4} className="rp-ylabel">{f(tv)}</text>
            {hasRight && <text x={padX + innerW + 8} y={yR(right.ticks[ti]) + 4} className="rp-ylabel" textAnchor="start">{fr(right.ticks[ti])}</text>}
          </g>
        ))}
        {area && series.map((s, si) => {
          if (isRight(s)) return null
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
          const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${yOf(s, p.value).toFixed(1)}`).join(' ')
          return (
            <g key={s.name}>
              <path d={path} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dashed ? '6 4' : undefined} />
              {n <= 24 && s.points.map((p, i) => (
                <circle key={i} cx={x(i)} cy={yOf(s, p.value)} r={hover === i ? 4 : 2.6} fill={color}
                  opacity={hover == null || hover === i ? 1 : 0.5} />
              ))}
              {showValues && s.points.map((p, i) => (
                <text key={`v${i}`} x={x(i)} y={labelY[si][i]} className="rp-dotval"
                  textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fill={color}>
                  {(isRight(s) ? fr : f)(p.value)}
                </text>
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
        {hasRight && rightLabel && (
          <text x={padX + innerW + 8} y={padT - 4} className="rp-ylabel" textAnchor="start" opacity={0.75}>{rightLabel}</text>
        )}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} className="rp-cursor" />}
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${(x(hover) / VW) * 100}%` }}>
          <b>{labels[hover]}</b>
          {series.map((s, si) => (
            <div key={s.name} className="rp-tip-row">
              <span className="rp-dot" style={{ background: s.color || CAT[si % CAT.length] }} />
              {s.name}: <b>{(isRight(s) ? fr : f)(s.points[hover].value)}</b>
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
        {/* rank digits live in their own far-left gutter so long names can't cover them */}
        {Array.from({ length: rowsShown }, (_, r) => (
          <text key={r} x={16} y={y(r + 1) + 4} className="rp-bump-rank" textAnchor="middle">{r + 1}</text>
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
export function ColumnChart({ data, color = CAT[0], line }: {
  data: Array<{ label: string; value: number; sub?: string }>; color?: string
  // optional overlay on its own right-hand axis (e.g. active headcount vs volume)
  line?: { name: string; color?: string; values: number[]; format?: (v: number) => string }
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (data.length === 0) return <Empty />
  const { max, ticks } = niceScale(Math.max(1, ...data.map((d) => d.value)))
  const lineCol = line?.color || CAT[3]
  const lf = line?.format || fmt.int
  const rs = niceScale(Math.max(1, ...(line?.values || [1])))
  // Narrower viewBox than the wide line charts: this one usually sits in a half-width
  // card, and a 1000-unit box shrinks every label past legibility there.
  const VW = 700, VH = 240, padL = 40, padR = line ? 38 : 10, padB = 28, padT = 22
  const innerW = VW - padL - padR, innerH = VH - padB - padT
  const slot = innerW / data.length
  const barW = Math.min(44, slot * 0.6)
  const n = data.length
  const step = Math.ceil(n / 16)
  const showVals = n <= 16
  const cxOf = (i: number) => padL + i * slot + slot / 2
  const yOf = (v: number) => padT + innerH * (1 - v / max)
  const yLine = (v: number) => padT + innerH * (1 - v / rs.max)
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {ticks.map((tv, ti) => (
          <g key={tv}>
            <line x1={padL} x2={VW - padR} y1={yOf(tv)} y2={yOf(tv)} className="rp-grid" />
            <text x={padL - 8} y={yOf(tv) + 4} className="rp-ylabel">{fmt.int(tv)}</text>
            {line && <text x={VW - padR + 8} y={yLine(rs.ticks[ti]) + 4} className="rp-ylabel" textAnchor="start">{lf(rs.ticks[ti])}</text>}
          </g>
        ))}
        {data.map((d, i) => {
          const h = (d.value / max) * innerH
          const cx = cxOf(i)
          const x = cx - barW / 2
          const y = yOf(d.value)
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={innerH} fill="transparent" />
              <rect x={x} y={y} width={barW} height={Math.max(h, 1)} rx={4}
                fill={color} opacity={hover == null || hover === i ? 1 : 0.45} />
              {showVals && <text x={cx} y={y - 6} className="rp-barval">{fmt.int(d.value)}</text>}
              {i % step === 0 && <text x={cx} y={VH - 10} className="rp-xlabel">{d.label}</text>}
            </g>
          )
        })}
        {line && (
          <g>
            <path d={line.values.map((v, i) => `${i ? 'L' : 'M'}${cxOf(i).toFixed(1)} ${yLine(v).toFixed(1)}`).join(' ')}
              fill="none" stroke={lineCol} strokeWidth={2.4} strokeDasharray="6 4" strokeLinejoin="round" strokeLinecap="round" />
            {line.values.map((v, i) => {
              // The bar's own value sits just above the bar top. Put the line label on
              // whichever side of the dot is clear of it, so the two never collide.
              const cx = cxOf(i), dotY = yLine(v), barTop = yOf(data[i]?.value ?? 0)
              // Never print the line's value over a bar. When the dot sits inside the
              // bar's body, move the label out to the side; otherwise put it above the
              // dot, lifted clear of the bar's own value label at barTop-6.
              const insideBar = dotY > barTop - 4
              const rightRoom = cx + barW / 2 + 26 < VW - padR
              const lx = insideBar ? cx + (rightRoom ? barW / 2 + 6 : -(barW / 2 + 6)) : cx
              const ly = insideBar ? dotY + 4
                : Math.abs((dotY - 9) - (barTop - 6)) < 13 ? barTop - 20 : dotY - 9
              return (
                <g key={i}>
                  <circle cx={cx} cy={dotY} r={3.4} fill={lineCol} stroke="var(--surface)" strokeWidth={1.4} />
                  {showVals && (
                    <text x={lx} y={Math.max(ly, 10)} className="rp-dotval" fill={lineCol}
                      textAnchor={insideBar ? (rightRoom ? 'start' : 'end') : 'middle'}>{lf(v)}</text>
                  )}
                </g>
              )
            })}
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="rp-tip" style={{ left: `${(cxOf(hover) / VW) * 100}%` }}>
          <b>{data[hover].label}</b><br />{fmt.int(data[hover].value)}{data[hover].sub ? ` · ${data[hover].sub}` : ''}
          {line && <><br /><span style={{ color: lineCol }}>●</span> {line.name}: <b>{lf(line.values[hover] ?? 0)}</b></>}
        </div>
      )}
      {line && (
        <div className="rp-legend rp-legend-horiz" style={{ marginTop: 6, marginBottom: 0 }}>
          <div className="rp-legend-row"><span className="rp-dot" style={{ background: color }} /><span className="rp-legend-name">Games evaluated</span></div>
          <div className="rp-legend-row"><span className="rp-dot" style={{ background: lineCol }} /><span className="rp-legend-name">{line.name}</span></div>
        </div>
      )}
    </div>
  )
}

// ---------- horizontal ranked bars ----------
export function RankBars({ rows, unit, color = CAT[0], format }: {
  // `sub` prints the raw numbers behind a derived value (a score or a rate means
  // nothing without the volume it was computed from)
  rows: Array<{ name: string; value: number; sub?: string }>; unit?: string; color?: string
  format?: (v: number) => string
}) {
  if (rows.length === 0) return <Empty />
  // Scale to the board's OWN peak so the leader always fills the capsule. The old
  // Math.max(1, …) floor silently broke every rate board: with values like 0.011
  // (1.1%) the peak became 1 and the top bar rendered at 1% of the track, making all
  // rows look identically empty and impossible to compare.
  const peak = Math.max(0, ...rows.map((r) => r.value))
  const max = peak > 0 ? peak : 1
  const f = format || fmt.int
  return (
    <div className="rp-rank">
      {rows.map((r, i) => (
        <div className="rp-rank-row" key={r.name}>
          <span className="rp-rank-i">{i + 1}</span>
          <span className="rp-rank-name" title={r.sub ? `${r.name} · ${r.sub}` : r.name}>
            {r.name}{r.sub && <span className="rp-rank-sub">{r.sub}</span>}
          </span>
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

// ---------- funnel (tapering stages + conversion %) ----------
// Drawn as real tapering bands so the shape itself carries the message. A funnel
// must never widen, but the data can: team Assigned counts NEW intake while
// Evaluated also clears older backlog, so Evaluated legitimately exceeds it. Widths
// therefore follow the running minimum (the shape stays a funnel) while the printed
// numbers stay true, and the offending stage says why it broke the sequence.
export function Funnel({ stages }: {
  stages: Array<{
    label: string; value: number; hint?: string
    // optional split of a stage into colored segments (e.g. Final Priority = Priority IV + Insight)
    parts?: Array<{ label: string; value: number; color: string }>
  }>
}) {
  const uid = useId().replace(/:/g, '')
  if (stages.length === 0 || stages.every((s) => s.value === 0)) return <Empty />
  // width driver = running minimum, so the shape only ever narrows
  const runMin: number[] = []
  stages.forEach((s, i) => runMin.push(i === 0 ? s.value : Math.min(runMin[i - 1], s.value)))
  const peak = Math.max(1, runMin[0])
  // Narrow viewBox: the funnel shares a row with other cards, so a 1000-unit box
  // would shrink its captions to noise in the half-width slot.
  const VW = 660, bandH = 58, gapH = 30, padT = 6
  const VH = padT + stages.length * bandH + (stages.length - 1) * gapH + 6
  // captions are SVG text (no wrapping), so the right gutter is sized for the longest
  // sub-line the component can emit and those lines are kept deliberately short
  const labelW = 112, valW = 160
  const cx = labelW + (VW - labelW - valW) / 2
  const halfW = (VW - labelW - valW) / 2
  const wOf = (v: number) => Math.max(3, (v / peak) * halfW * 2) / 2 // half-width, min 3px sliver
  const topY = (i: number) => padT + i * (bandH + gapH)
  // sequential blue ramp, dark at the wide top → light at the narrow tip
  const shade = (i: number) => `color-mix(in srgb, ${CAT[0]} ${Math.round(100 - i * 14)}%, #ffffff)`
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg rp-funnel-svg" preserveAspectRatio="xMidYMid meet">
        {stages.map((s, i) => {
          const y0 = topY(i), y1 = y0 + bandH
          const wTop = wOf(runMin[i])
          // taper toward the next stage so the neck between bands reads as a drop
          const wBot = i < stages.length - 1 ? Math.max(wOf(runMin[i + 1]), wTop * 0.35) : wTop * 0.9
          const overflow = s.value > runMin[i]
          const path = `M${cx - wTop} ${y0} L${cx + wTop} ${y0} L${cx + wBot} ${y1} L${cx - wBot} ${y1} Z`
          const prev = i > 0 ? stages[i - 1].value : null
          const conv = prev && prev > 0 ? (s.value / prev) * 100 : null
          const clip = `fn-${uid}-${i}`
          const parts = s.parts?.filter((p) => p.value > 0) || []
          let acc = 0
          return (
            <g key={s.label}>
              {parts.length ? (
                <>
                  <defs><clipPath id={clip}><path d={path} /></clipPath></defs>
                  {parts.map((p) => {
                    const x0 = cx - wTop + (acc / s.value) * wTop * 2
                    const w = (p.value / s.value) * wTop * 2
                    acc += p.value
                    return <rect key={p.label} x={x0} y={y0} width={Math.max(w, 1)} height={bandH} fill={p.color} clipPath={`url(#${clip})`} />
                  })}
                  <path d={path} fill="none" stroke="var(--surface)" strokeWidth={1} />
                </>
              ) : (
                <path d={path} fill={shade(i)} />
              )}
              <text x={labelW - 16} y={y0 + bandH / 2 + 5} className="rp-fn-label" textAnchor="end">{s.label}</text>
              <text x={VW - valW + 16} y={y0 + bandH / 2 - 3} className="rp-fn-val" textAnchor="start">{fmt.int(s.value)}</text>
              <text x={VW - valW + 16} y={y0 + bandH / 2 + 14} className="rp-fn-sub" textAnchor="start">
                {parts.length
                  ? parts.map((p) => `${fmt.int(p.value)} ${p.label.replace('Priority ', 'P-')}`).join(' + ')
                  : overflow ? 'incl. older backlog'
                  : conv != null ? `${Math.round(conv)}% of ${stages[i - 1].label.toLowerCase()}` : 'new intake'}
              </text>
              {conv != null && (
                <text x={cx} y={y0 - gapH / 2 + 5} className="rp-fn-conv" textAnchor="middle">
                  ↓ {Math.round(conv)}% of {stages[i - 1].label.toLowerCase()}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

// ---------- radar (N axes, one or more overlaid series) ----------
export function Radar({ axes, series, size = 240, axisRaw }: {
  axes: string[]
  series: Array<{ name: string; values: number[]; color?: string }> // values 0..100 aligned to axes
  size?: number
  // raw (un-normalized) value per axis, printed under the axis name - the polygon is
  // relative to the team best, which alone never tells you the actual number
  axisRaw?: string[]
}) {
  const [hi, setHi] = useState<number | null>(null)
  if (axes.length < 3) return <Empty />
  // Axis captions live in their own horizontal gutter inside the viewBox. They used
  // to be drawn with overflow:visible and spilled over the neighbouring legend.
  const GX = 86, GT = axisRaw ? 26 : 10, GB = axisRaw ? 34 : 22
  const cx = size / 2, cy = size / 2, R = size / 2 - 34
  const ang = (i: number) => (i / axes.length) * 2 * Math.PI - Math.PI / 2
  const pt = (i: number, r: number) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))]
  const rings = [0.25, 0.5, 0.75, 1]
  return (
    <div className="rp-radar-wrap">
      <svg width={size + GX * 2} height={size + GT + GB} viewBox={`${-GX} ${-GT} ${size + GX * 2} ${size + GT + GB}`}>
        {/* grid rings */}
        {rings.map((g) => (
          <polygon key={g} className="rp-radar-grid"
            points={axes.map((_, i) => pt(i, R * g).join(',')).join(' ')} />
        ))}
        {/* spokes + labels */}
        {axes.map((a, i) => {
          const [x, y] = pt(i, R)
          const [lx, ly] = pt(i, R + 15)
          const below = ly > cy + 6
          const anchor = Math.abs(lx - cx) < 6 ? 'middle' : lx > cx ? 'start' : 'end'
          return (
            <g key={a}>
              <line className="rp-radar-spoke" x1={cx} y1={cy} x2={x} y2={y} />
              <text x={lx} y={ly} className="rp-radar-axis" textAnchor={anchor}
                dominantBaseline={Math.abs(ly - cy) < 6 ? 'middle' : below ? 'hanging' : 'auto'}>{a}</text>
              {axisRaw?.[i] && (
                <text x={lx} y={ly + (below ? 15 : 12)} className="rp-radar-raw" textAnchor={anchor}
                  dominantBaseline={below ? 'hanging' : 'auto'}>{axisRaw[i]}</text>
              )}
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

// ---------- team health gauges ----------
// Each row is a metric read against a benchmark, not a bar of arbitrary length: the
// track is scaled so the TARGET sits at a fixed position, the fill shows where the
// team actually is, and the row states the raw counts behind the ratio plus the
// change against the previous period. A bare percentage bar told the reader nothing
// about whether 18% was good.
export function HealthBars({ rows }: {
  rows: Array<{
    label: string; value: string
    detail?: string            // raw counts behind the ratio ("198 of 1,130 assigned")
    pct: number                // fill position 0-100, already scaled against the target
    target?: number            // target marker position 0-100 (omit for "no benchmark")
    targetLabel?: string       // what the marker means ("target 10%")
    delta?: number | null      // change vs previous period, in the metric's own unit
    deltaLabel?: string        // e.g. "pts vs prev week"
    status: 'good' | 'warn' | 'bad'
  }>
}) {
  const col = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' }
  return (
    <div className="rp-hb">
      {rows.map((r) => {
        const up = r.delta != null && r.delta > 0
        const flat = r.delta == null || Math.abs(r.delta) < 1e-9
        return (
          <div className="rp-hb-row" key={r.label}>
            <div className="rp-hb-top">
              <span className="rp-hb-label">{r.label}</span>
              <span className="rp-hb-val" style={{ color: col[r.status] }}>{r.value}</span>
            </div>
            <div className="rp-hb-track">
              <div className="rp-hb-fill" style={{ width: `${Math.max(1.5, Math.min(100, r.pct))}%`, background: col[r.status] }} />
              {r.target != null && (
                <span className="rp-hb-target" style={{ left: `${Math.min(99, r.target)}%` }} title={r.targetLabel} />
              )}
            </div>
            <div className="rp-hb-foot">
              <span className="rp-hb-detail">{r.detail}</span>
              <span className="rp-hb-meta">
                {r.targetLabel && <span className="rp-hb-tgt">{r.targetLabel}</span>}
                {!flat && (
                  <span className={'rp-hb-delta ' + (up ? 'up' : 'down')}>
                    {up ? '▲' : '▼'} {Math.abs(r.delta!) < 10 ? Math.abs(r.delta!).toFixed(1) : Math.round(Math.abs(r.delta!))} {r.deltaLabel}
                  </span>
                )}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------- stacked conclusion bars per evaluator ----------
export function StackedBars({ rows, keys, colors, unit }: {
  rows: Array<{ name: string; parts: Record<string, number> }>
  keys: string[] // conclusion names in stack order
  colors?: Record<string, string> // override the conclusion palette (e.g. age bands)
  unit?: string // noun for the hover line, default "their"
}) {
  const colorOf = (k: string, i: number) => colors?.[k] || conclusionColor(k, i)
  const [hover, setHover] = useState<string | null>(null)
  const [seg, setSeg] = useState<{ name: string; k: string; v: number; total: number } | null>(null)
  if (rows.length === 0) return <Empty />
  const totals = rows.map((r) => keys.reduce((s, k) => s + (r.parts[k] || 0), 0))
  const max = Math.max(1, ...totals)
  return (
    <div>
      <div className="rp-legend rp-legend-horiz">
        {keys.map((k, i) => (
          <div className="rp-legend-row" key={k} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <span className="rp-dot" style={{ background: colorOf(k, i) }} /><span className="rp-legend-name">{k}</span>
          </div>
        ))}
      </div>
      {/* hovered-segment stats (reserved height so the chart doesn't jump) */}
      <div className="rp-stack-info">
        {seg ? (
          <>
            <span className="rp-dot" style={{ background: colorOf(seg.k, keys.indexOf(seg.k)) }} />
            <span>{seg.name} · {seg.k}: <b>{fmt.int(seg.v)}</b> ({Math.round((seg.v / seg.total) * 100)}% of {unit || 'their'} {fmt.int(seg.total)})</span>
          </>
        ) : <span style={{ opacity: .55 }}>Hover a segment for exact counts</span>}
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
                  onMouseEnter={() => { setHover(k); setSeg({ name: r.name, k, v, total: totals[ri] }) }}
                  onMouseLeave={() => { setHover(null); setSeg(null) }}
                  style={{ width: `${(v / max) * 100}%`, background: colorOf(k, i), opacity: hover && hover !== k ? 0.3 : 1 }} />
              })}
            </span>
            <span className="rp-stack-total">{fmt.int(totals[ri])}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
