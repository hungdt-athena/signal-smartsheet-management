'use client'
// Hand-rolled SVG/CSS chart primitives for the Report tab. No chart library - keeps
// the bundle small and matches the app's existing inline-SVG style. Palette is the
// dataviz-validated categorical set; conclusion hues reuse the app's badge intent.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

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
  // Same, with a decimal forced. For the case where two numbers being COMPARED round
  // to the same string: "Shortlist rate 7% … team 7% -7%" is unreadable, because the
  // two figures the badge is the gap between are printed identically.
  pct1: (n: number) => `${(n * 100).toFixed(1)}%`,
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
      {/* Drawn, not typed. A "?" glyph in a bordered span picks up the reader's font
          and their browser's emoji substitution, so it rendered a different size on
          every machine and, on some, as a coloured emoji. */}
      <span className="rp-qtip-icon" role="img" aria-label="What is this?">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6.2 6.25a1.8 1.8 0 1 1 2.35 1.72c-.48.18-.55.5-.55.93v.2"
            fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
        </svg>
      </span>
      {pos && (
        <span className="rp-qtip-pop" role="tooltip" style={{ left: pos.x, top: pos.y }}>
          {title && <span className="rp-qtip-title">{title}</span>}
          <span className="rp-qtip-body">{children}</span>
        </span>
      )}
    </span>
  )
}


// ---------- KPI card (optional inline sparkline) ----------
// A benchmark line under a KPI: what the team does on the same metric, and how far
// this value sits from it. `tone` is passed in because "better" is metric-specific
// (higher throughput is good, higher turnaround is not).
export type Bench = { text: string; delta: number | null; tone: 'good' | 'bad' | 'flat' }

export function Kpi({ label, value, sub, trend, trendLabel, hi, spark, sparkNote, sparkColor, tip, bench, noTrend, focusKey }: {
  label: string; value: string; sub?: string; trend?: number | null; hi?: boolean
  spark?: number[]; sparkColor?: string; tip?: ReactNode; bench?: Bench | null
  // What the ±% badge is comparing against, e.g. "vs last month". REQUIRED for the
  // badge to render at all. A bare "−4%" beside a number is unreadable: it was
  // derived from the last two points of the sparkline, which is a quantity nobody can
  // name by looking at it, and the reader has no way to tell that from a comparison
  // against the previous window. If there is nothing to call it, it does not print.
  trendLabel?: string
  // What the sparkline plots, e.g. "games per day". Same rule: a line with no unit is
  // a shape, not a reading.
  sparkNote?: string
  // Suppress the derived bucket-over-bucket badge. Set it when the VALUE is a window
  // aggregate (a total, or a rate over the whole window): the sparkline's last step is
  // then a different quantity than the number beside it, and "3,175 evaluated, −96%"
  // reads as a collapse when all it means is that the last bucket was a Saturday.
  noTrend?: boolean
  // Names this KPI as the landing place for the Overview chip and the actions that were
  // computed from it. The tab looks the target up by this attribute, so the chip never
  // has to know where on the page the number ended up.
  focusKey?: string
}) {
  const tclass = trend == null ? '' : trend > 0 ? 'up' : trend < 0 ? 'down' : ''
  // derive a trend from the sparkline tail if none was supplied
  let autoTrend = trend
  if (autoTrend == null && !noTrend && spark && spark.length >= 2) {
    const a = spark[spark.length - 2], b = spark[spark.length - 1]
    if (a > 0) autoTrend = (b - a) / a
  }
  const at = autoTrend == null ? '' : autoTrend > 0.001 ? 'up' : autoTrend < -0.001 ? 'down' : ''
  const col = sparkColor || (hi ? 'var(--accent-strong)' : 'var(--accent)')
  return (
    <div className={'rp-kpi' + (hi ? ' hi' : '')} data-rp-focus={focusKey}>
      <div className="rp-kpi-label">{label}{tip && <InfoTip title={label}>{tip}</InfoTip>}</div>
      <div className="rp-kpi-main">
        <div className="rp-kpi-value">{value}</div>
        {spark && spark.length >= 2 && <Sparkline data={spark} color={col} title={sparkNote} />}
      </div>
      <div className="rp-kpi-sub">
        {sub}
        {sparkNote && spark && spark.length >= 2 && <span className="rp-kpi-sparknote">{sparkNote}</span>}
        {/* No label, no badge - see `trendLabel` above. */}
        {trendLabel && (trend != null
          ? <span className={'rp-trend ' + tclass}>{fmt.signed(trend)} <i>{trendLabel}</i></span>
          : autoTrend != null && at ? <span className={'rp-trend ' + at}>{fmt.signed(autoTrend)} <i>{trendLabel}</i></span> : null)}
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
export function Sparkline({ data, color = CAT[0], w = 76, h = 30, title }: {
  data: number[]; color?: string; w?: number; h?: number
  // What the line plots. Rendered as <title>, so it is both the hover text and what a
  // screen reader gets instead of an unnamed shape.
  title?: string
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
    <svg className="rp-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none"
      role={title ? 'img' : undefined} aria-label={title}>
      {title && <title>{title}</title>}
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
  // One y axis for everything. A series can opt out of the area fill when it would
  // paint over the lines beneath it, which is what a large cumulative series does.
  series: Array<{ name: string; color?: string; dashed?: boolean; area?: boolean; points: Array<{ label: string; value: number }> }>
  area?: boolean; format?: (v: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const uid = useId().replace(/:/g, '')
  const n = series[0]?.points.length || 0
  if (n === 0) return <Empty />
  const f = format || fmt.int
  const left = niceScale(Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.value))))
  const VW = 1000, padL = 48, padR = 16, padT = 18, xLabH = 26, mainH = 214
  const innerW = VW - padL - padR
  const mainTop = padT, mainBot = padT + mainH
  const VH = mainBot + xLabH
  const x = (i: number) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v: number) => mainBot - (v / left.max) * mainH
  const labels = series[0].points.map((p) => p.label)
  const step = Math.ceil(n / 12)

  // Values are printed at the FIRST and LAST point only. Labelling every point turns
  // a 7-day chart into 21 numbers competing with the gridlines; first and last are
  // the two a reader takes away, and the hover gives the rest. Labels at the same
  // index are pushed apart vertically so each one belongs to exactly one dot.
  const marked = n >= 2 ? [0, n - 1] : [0]
  const labelY: Record<number, number[]> = {}
  for (const i of marked) {
    const col: number[] = []
    const order = series.map((s, si) => ({ si, yy: y(s.points[i].value) })).sort((a, b) => b.yy - a.yy)
    let floor = Infinity
    for (const o of order) {
      col[o.si] = Math.max(Math.min(o.yy - 9, floor - 14), mainTop - 4)
      floor = col[o.si]
    }
    labelY[i] = col
  }
  // first label reads rightward off the dot, last reads leftward, so neither runs
  // into the y-axis gutter or off the right edge
  const anchorAt = (i: number): 'start' | 'end' | 'middle' => (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle')

  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {left.ticks.map((tv) => (
          <g key={tv}>
            <line x1={padL} x2={padL + innerW} y1={y(tv)} y2={y(tv)} className="rp-grid" />
            <text x={padL - 8} y={y(tv) + 4} className="rp-ylabel">{f(tv)}</text>
          </g>
        ))}
        {series.map((s, si) => {
          if (!(s.area ?? area)) return null
          const color = s.color || CAT[si % CAT.length]
          const gid = `lg-${uid}-${si}`
          const path = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
          const fill = `${path} L${x(n - 1).toFixed(1)} ${mainBot} L${x(0).toFixed(1)} ${mainBot} Z`
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
              <path d={path} fill="none" stroke={color} strokeWidth={2.4} strokeLinejoin="round" strokeLinecap="round"
                strokeDasharray={s.dashed ? '6 4' : undefined} />
              {n <= 24 && s.points.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(p.value)} r={hover === i ? 4 : 2.6} fill={color}
                  opacity={hover == null || hover === i ? 1 : 0.5} />
              ))}
              {marked.map((i) => (
                <text key={`v${i}`} x={x(i)} y={labelY[i][si]} className="rp-dotval"
                  textAnchor={anchorAt(i)} fill={color}>{f(s.points[i].value)}</text>
              ))}
            </g>
          )
        })}

        {labels.map((l, i) => i % step === 0 && (
          <text key={i} x={x(i)} y={VH - 8} className="rp-xlabel">{l}</text>
        ))}
        {labels.map((_, i) => (
          <rect key={i} x={x(i) - innerW / (2 * Math.max(1, n - 1))} y={mainTop}
            width={innerW / Math.max(1, n - 1)} height={mainH} fill="transparent"
            onMouseEnter={() => setHover(i)} />
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={mainTop} y2={mainBot} className="rp-cursor" />}
      </svg>
      {hover != null && (
        <ChartTip label={labels[hover]} left={(x(hover) / VW) * 100}
          rows={series.map((s, si) => ({ name: s.name, color: s.color || CAT[si % CAT.length], value: f(s.points[hover].value), raw: s.points[hover].value }))} />
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

// ---------- hover tooltip shared by the charts ----------
// One row per series, name left and value right on its own line, so two numbers of
// different widths still line up. The largest value in the group is called out:
// on a flow chart that is the whole reading (which side is winning today).
export function ChartTip({ label, left, rows }: {
  label: string; left: number
  rows: Array<{ name: string; color: string; value: string; raw?: number | null; note?: string }>
}) {
  const comparable = rows.filter((r) => typeof r.raw === 'number') as Array<{ raw: number }>
  const top = comparable.length > 1 ? Math.max(...comparable.map((r) => r.raw)) : null
  // Centred on the hovered point until that would hang off an edge, then anchored to
  // the edge instead. A tip is at least 138px wide; on the first or last bucket of a
  // narrow card half of it used to sit outside the chart, and in a card near the page
  // edge that meant outside the window, clipped with no way to scroll to it.
  const x = Math.max(0, Math.min(100, left))
  const anchor = x < 20 ? 'flex-start' : x > 80 ? 'flex-end' : 'center'
  return (
    <div className={`rp-tip ${anchor === 'center' ? 'mid' : anchor === 'flex-start' ? 'start' : 'end'}`}
      style={{ left: `${x}%` }}>
      <div className="rp-tip-head">{label}</div>
      {rows.map((r) => (
        <div className={'rp-tip-row' + (top != null && r.raw === top ? ' lead' : '')} key={r.name}>
          <span className="rp-tip-key"><span className="rp-dot" style={{ background: r.color }} />{r.name}</span>
          <span className="rp-tip-val">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

// ---------- scatter / quadrant ----------
// Bubbles collide by nature: two people with similar output land on the same spot, and
// the old version then stacked their names on each other until neither could be read.
// Four things fix that, in order of how much they matter:
//   1. Round axis ticks from `niceScale`. 0 · 500 · 1,000 is a scale; 0 · 471 · 942 is
//      the maximum divided by four, and the reader has to do arithmetic to place a dot.
//   2. A surface-coloured ring on every bubble, so two overlapping marks read as two
//      marks instead of one blotch.
//   3. Greedy label placement - four candidate positions per name, largest bubble
//      first, and a name that fits nowhere is simply not drawn. A dropped label is
//      recoverable (hover names the point); an overlapping one is not.
//   4. Everything is drawn largest-first, so a small bubble is never buried.
export function Scatter({ points, xLabel, yLabel, xFormat, yFormat, sizeLabel, avgX, avgY, avgXLabel, avgYLabel, emphasis }: {
  points: Array<{ name: string; x: number; y: number; size?: number; color?: string }>
  xLabel: string; yLabel: string
  xFormat?: (v: number) => string; yFormat?: (v: number) => string
  // What the bubble's AREA means. Without it the tooltip called the third row "Games",
  // which is the x axis under a different name.
  sizeLabel?: string
  // The reference lines. They default to the mean of what is plotted, but a mean of
  // ratios is the wrong average for a ratio: the caller passes the pooled figure
  // (total over total) so the line sits where the team actually is.
  avgX?: number; avgY?: number; avgXLabel?: string; avgYLabel?: string
  // Names to draw heavier - the points the caller's own threshold picked out.
  emphasis?: Array<{ name: string; tone: 'high' | 'low' }>
}) {
  const [hover, setHover] = useState<number | null>(null)
  // the hovered bubble's own viewport rect, so the tooltip can be placed beside it
  const [at, setAt] = useState<DOMRect | null>(null)
  if (points.length === 0) return <Empty />
  const xf = xFormat || fmt.dec, yf = yFormat || fmt.int
  const VW = 680, VH = 432, padL = 64, padB = 46, padT = 22, padR = 20
  const innerW = VW - padL - padR, innerH = VH - padB - padT
  const sx = niceScale(Math.max(...points.map((p) => p.x)), 4)

  // ---- y scale, with a break through an empty middle ----
  // One person at 88% and four under 17% makes three-quarters of the plot a blank
  // rectangle, and squashes the four people who are actually being compared into a
  // strip. The empty band is cut out and marked, so the height goes to the data.
  //
  // The rule is deliberately hard to trigger: the run has to be empty across at least
  // 40% of the full range AND leave two clear tick steps between the bands. A softer
  // rule broke a perfectly ordinary week between 5% and 12%, where the gap is just how
  // the team is spread out - which is the reading, not something to cut away.
  const ysAll = [...points.map((p) => p.y), ...(avgY != null ? [avgY] : [])].sort((a, b) => a - b)
  const sTop = niceScale(ysAll[ysAll.length - 1], 4)
  const step = sTop.ticks.length > 1 ? sTop.ticks[1] - sTop.ticks[0] : sTop.max / 4
  const brk = (() => {
    if (ysAll.length < 4) return null
    let gi = -1, gw = 0
    for (let i = 1; i < ysAll.length; i++) {
      const w = ysAll[i] - ysAll[i - 1]
      if (w > gw) { gw = w; gi = i }
    }
    if (gi < 3 || gw < sTop.max * 0.4) return null
    // Five steps, not four, for the lower band: niceScale rounds its maximum UP to a
    // whole number of steps, so a coarser count overshoots and hands the empty part of
    // the lower band back the room the cut just freed (21% became a band to 40%).
    const sLow = niceScale(ysAll[gi - 1], 5)
    const hiEdge = Math.floor(ysAll[gi] / step) * step
    if (hiEdge - sLow.max < sTop.max * 0.25) return null
    return { loEdge: sLow.max, hiEdge, ticks: [...sLow.ticks, hiEdge, sTop.max] }
  })()
  const sy = { max: sTop.max, ticks: brk ? brk.ticks : sTop.ticks }
  const meanX = avgX ?? points.reduce((s, p) => s + p.x, 0) / points.length
  const meanY = avgY ?? points.reduce((s, p) => s + p.y, 0) / points.length
  const maxSize = Math.max(1, ...points.map((p) => p.size || 1))
  const px = (v: number) => padL + (v / sx.max) * innerW
  // Two bands and a gap, as fractions of the plot height. The lower band gets twice the
  // room because that is where the people being compared are.
  const lowH = innerH * 0.62, brkH = innerH * 0.08, hiH = innerH - lowH - brkH
  const py = (v: number) => {
    if (!brk) return padT + innerH * (1 - v / sy.max)
    if (v <= brk.loEdge) return padT + innerH - (v / brk.loEdge) * lowH
    if (v < brk.hiEdge) {
      // nothing should land here; if the caller's data shifts, put it in the gap rather
      // than off the chart
      const t = (v - brk.loEdge) / Math.max(1e-9, brk.hiEdge - brk.loEdge)
      return padT + innerH - lowH - t * brkH
    }
    return padT + hiH - ((v - brk.hiEdge) / Math.max(1e-9, sy.max - brk.hiEdge)) * hiH
  }
  const brkTop = padT + hiH, brkBot = padT + innerH - lowH
  // Smaller than it was (5-18px): bubbles that touch are harder to count than bubbles
  // that do not, and the size channel only has to be ordinal to be read.
  const rad = (s?: number) => 4 + Math.sqrt((s || 1) / maxSize) * 9
  const hot = new Map((emphasis || []).map((e) => [e.name, e.tone]))

  // Label placement. Boxes are approximate - jsdom and the browser both lack a cheap
  // text measurement here - but the labels are absolutely positioned text nodes, so
  // an approximate box that is consistently too WIDE errs toward dropping a label
  // rather than toward printing two on top of each other.
  const LH = 11, CW = 6.5, GAP = 3
  type Box = [number, number, number, number]
  type Spot = { x: number; y: number; anchor: 'middle' | 'start' | 'end' }
  const boxes: Box[] = []
  const hits = (b: Box, o: Box) =>
    b[0] < o[2] + GAP && b[2] + GAP > o[0] && b[1] < o[3] + GAP && b[3] + GAP > o[1]
  const inside = (b: Box) => b[0] >= 2 && b[2] <= VW - 2 && b[1] >= 2 && b[3] <= padT + innerH
  const boxOf = (t: Spot, name: string): Box => {
    const w = name.length * CW
    const x1 = t.anchor === 'middle' ? t.x - w / 2 : t.anchor === 'start' ? t.x : t.x - w
    return [x1, t.y - LH, x1 + w, t.y + 2]
  }
  const spots = (i: number): Spot[] => {
    const p = points[i], r = rad(p.size), cx = px(p.x), cy = py(p.y)
    return [
      { x: cx, y: cy - r - 5, anchor: 'middle' },
      { x: cx, y: cy + r + LH + 1, anchor: 'middle' },
      { x: cx + r + 5, y: cy + 4, anchor: 'start' },
      { x: cx - r - 5, y: cy + 4, anchor: 'end' },
    ]
  }
  // The two mean lines carry text of their own; reserve it before any name is placed.
  const qxW = ((avgXLabel || `team avg ${xLabel}`).length + 1) * CW
  const qyW = ((avgYLabel || `team avg ${yLabel}`).length + 1) * CW
  boxes.push([px(meanX) + 5, padT, px(meanX) + 5 + qxW, padT + LH])
  boxes.push([VW - padR - qyW, py(meanY) - LH - 3, VW - padR, py(meanY) - 3])
  const bySize = points.map((_, i) => i).sort((a, b) => rad(points[b].size) - rad(points[a].size))
  const labels: Array<Spot | null> = points.map(() => null)
  for (const i of bySize) {
    for (const t of spots(i)) {
      const box = boxOf(t, points[i].name)
      if (inside(box) && !boxes.some((o) => hits(box, o))) { labels[i] = t; boxes.push(box); break }
    }
  }

  const hp = hover != null ? points[hover] : null
  // A point that lost the placement contest still names itself on hover. That label has
  // to displace whatever it lands on, or the hover puts two names on the same pixels -
  // which is the problem the placement pass exists to prevent, arriving by another door.
  const hoverSpot = hp && !labels[hover!] ? spots(hover!).find((t) => inside(boxOf(t, hp.name))) || spots(hover!)[0] : null
  const hoverBox = hoverSpot && hp ? boxOf(hoverSpot, hp.name) : null
  const covered = hoverBox
    ? new Set(points.map((p, i) => (labels[i] && hits(boxOf(labels[i]!, p.name), hoverBox) ? i : -1)).filter((i) => i >= 0))
    : new Set<number>()
  return (
    <div className="rp-chart-wrap">
      <svg viewBox={`0 0 ${VW} ${VH}`} className="rp-svg" preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}>
        {sy.ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={VW - padR} y1={py(t)} y2={py(t)} className="rp-grid" />
            <text x={padL - 10} y={py(t) + 4} className="rp-ylabel">{yf(t)}</text>
          </g>
        ))}
        {sx.ticks.map((t) => (
          <text key={t} x={px(t)} y={VH - padB + 18} className="rp-xlabel">{xf(t)}</text>
        ))}
        {/* the cut. Painted over the gridlines in the surface colour and bounded top and
            bottom, so the axis visibly stops and restarts rather than silently lying
            about the distance between two points. */}
        {brk && (
          <g>
            <rect x={padL - 1} y={brkTop} width={VW - padR - padL + 2} height={brkBot - brkTop} fill="var(--surface)" />
            <line x1={padL} x2={VW - padR} y1={brkTop} y2={brkTop} className="rp-brk-edge" />
            <line x1={padL} x2={VW - padR} y1={brkBot} y2={brkBot} className="rp-brk-edge" />
            <text x={padL + innerW / 2} y={(brkTop + brkBot) / 2 + 3.5} className="rp-brk-cap" textAnchor="middle">
              nobody between {yf(brk.loEdge)} and {yf(brk.hiEdge)}
            </text>
          </g>
        )}
        {/* mean quadrant lines - the reading is which side of them a bubble sits on */}
        <line x1={px(meanX)} x2={px(meanX)} y1={padT} y2={padT + innerH} className="rp-quad" />
        <line x1={padL} x2={VW - padR} y1={py(meanY)} y2={py(meanY)} className="rp-quad" />
        <text x={px(meanX) + 5} y={padT + 9} className="rp-quad-lbl">{avgXLabel || `team avg ${xLabel.toLowerCase()}`}</text>
        <text x={VW - padR} y={py(meanY) - 5} className="rp-quad-lbl" textAnchor="end">{avgYLabel || `team avg ${yLabel.toLowerCase()}`}</text>
        {bySize.map((i) => {
          const p = points[i], c = p.color || CAT[i % CAT.length], on = hover === i, dim = hover != null && !on
          return (
            <g key={p.name} onMouseEnter={(e) => { setHover(i); setAt(e.currentTarget.getBoundingClientRect()) }}
              onMouseLeave={() => { setHover(null); setAt(null) }}>
              {/* ring first, in the surface colour: where two bubbles overlap it is the
                  only thing that keeps them countable */}
              <circle cx={px(p.x)} cy={py(p.y)} r={rad(p.size) + 1.5} fill="none"
                stroke="var(--surface)" strokeWidth={2.5} opacity={dim ? 0.5 : 1} />
              <circle cx={px(p.x)} cy={py(p.y)} r={rad(p.size)} fill={c}
                fillOpacity={dim ? 0.16 : on ? 0.82 : 0.6} stroke={c}
                strokeWidth={on ? 2.4 : hot.has(p.name) ? 2.4 : 1.2}
                strokeOpacity={dim ? 0.3 : 1} />
              {/* An outlier is marked by a SHAPE as well as a colour - a dashed ring
                  reads in greyscale, in print, and to a colourblind reader. */}
              {hot.has(p.name) && (
                <circle cx={px(p.x)} cy={py(p.y)} r={rad(p.size) + 5} fill="none"
                  className={`rp-out-ring ${hot.get(p.name)}`} opacity={dim ? 0.3 : 1} />
              )}
            </g>
          )
        })}
        {points.map((p, i) => labels[i] && !covered.has(i) && (
          <text key={p.name} x={labels[i]!.x} y={labels[i]!.y} textAnchor={labels[i]!.anchor}
            className={'rp-scatter-lbl' + (hover === i ? ' on' : hover != null ? ' dim' : '') + (hot.has(p.name) ? ` hot ${hot.get(p.name)}` : '')}>{p.name}</text>
        ))}
        {hp && hoverSpot && (
          <text x={hoverSpot.x} y={hoverSpot.y} textAnchor={hoverSpot.anchor} className="rp-scatter-lbl on">{hp.name}</text>
        )}
        <text x={padL + innerW / 2} y={VH - 4} className="rp-axis-title" textAnchor="middle">{xLabel}</text>
        <text x={-(padT + innerH / 2)} y={14} className="rp-axis-title" textAnchor="middle" transform="rotate(-90)">{yLabel}</text>
      </svg>
      {/* Beside the bubble and clamped to the window. Anchored to the chart box it hung
          off the top of the screen whenever the card was scrolled past, which is exactly
          when someone is hovering it. */}
      {hp && at && (
        <FixedTip rect={at} label={hp.name} rows={[
          { name: xLabel, color: hp.color || CAT[hover! % CAT.length], value: xf(hp.x) },
          { name: yLabel, color: hp.color || CAT[hover! % CAT.length], value: yf(hp.y) },
          ...(hp.size != null && sizeLabel ? [{ name: sizeLabel, color: 'var(--faint)', value: fmt.dec(hp.size) }] : []),
        ]} />
      )}
    </div>
  )
}

// A tooltip placed from the mark's own viewport rect: to its right when there is room,
// to its left when there is not, and always inside the window. `position: fixed` so no
// card, grid or scroll container can clip it.
function FixedTip({ rect, label, rows }: {
  rect: DOMRect; label: string
  rows: Array<{ name: string; color: string; value: string }>
}) {
  const W = 186, H = 34 + rows.length * 19
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  let x = rect.right + 12
  if (x + W > vw - 8) x = rect.left - W - 12
  x = Math.min(Math.max(8, x), Math.max(8, vw - W - 8))
  const y = Math.min(Math.max(8, rect.top + rect.height / 2 - H / 2), Math.max(8, vh - H - 8))
  return (
    <div className="rp-tip fixed" style={{ left: x, top: y, width: W }}>
      <div className="rp-tip-head">{label}</div>
      {rows.map((r) => (
        <div className="rp-tip-row" key={r.name}>
          <span className="rp-tip-key"><span className="rp-dot" style={{ background: r.color }} />{r.name}</span>
          <span className="rp-tip-val">{r.value}</span>
        </div>
      ))}
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
export function ColumnChart({ data, color = CAT[0], line, name = 'Games', fill }: {
  data: Array<{ label: string; value: number; sub?: string }>; color?: string
  // optional overlay on its own right-hand axis (e.g. active headcount vs volume)
  line?: { name: string; color?: string; values: number[]; format?: (v: number) => string }
  // What one bar counts, for the tooltip. It said "Games" for every chart, which on a
  // headcount chart read "Games 9" under a column meaning nine people.
  name?: string
  // Grow to the height of the card instead of to the viewBox's aspect ratio. Set it
  // when the card sits in a grid row beside a taller one, where a fixed ratio leaves
  // the chart stranded at the top with dead space under it.
  fill?: boolean
}) {
  const [hover, setHover] = useState<number | null>(null)
  // Measured, not assumed: an SVG cannot stretch one axis without distorting its text,
  // so the viewBox height is recomputed from the box the browser actually gave us.
  // jsdom reports 0 and falls through to the default, which is what the tests read.
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxH, setBoxH] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!fill || !el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fill])
  if (data.length === 0) return <Empty />
  const { max, ticks } = niceScale(Math.max(1, ...data.map((d) => d.value)))
  const lineCol = line?.color || CAT[3]
  const lf = line?.format || fmt.int
  const rs = niceScale(Math.max(1, ...(line?.values || [1])))
  // Narrower viewBox than the wide line charts: this one usually sits in a half-width
  // card, and a 1000-unit box shrinks every label past legibility there.
  const VW = 700, padL = 40, padR = line ? 38 : 10, padB = 28, padT = 22
  // Scale the measured pixel height into viewBox units so the bars grow but the labels
  // keep their size relative to the width.
  const VH = fill && boxH > 0 ? Math.max(200, Math.min(900, (boxH / (boxRef.current?.clientWidth || VW)) * VW)) : 240
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
    <div className={'rp-chart-wrap' + (fill ? ' fill' : '')} ref={boxRef}>
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
        <ChartTip label={data[hover].label} left={(cxOf(hover) / VW) * 100} rows={[
          { name: data[hover].sub || name, color, value: fmt.int(data[hover].value) },
          ...(line ? [{ name: line.name, color: lineCol, value: lf(line.values[hover] ?? 0) }] : []),
        ]} />
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

// ---------- per-person queue: how much is waiting, and how long it has waited ----------
// A stock chart, not a flow one. Every bar is read as of NOW and none of it is sliced
// by the window, so the bars sum to the same backlog the Overview KPI shows. That is
// the whole point of putting it here: Overview says the queue is 5,475 games, and this
// says whose desks those games are on.
//
// Bands are days since the game was ASSIGNED to this person, which is deliberately not
// the clock Overview's "Backlog by age" uses (days since import). On a per-person card
// the question is how long this person has held it, and a handover restamps that date
// - the new owner's clock starts when they receive the game, which is the fair reading
// and the same one "Days waiting" already uses.
//
// `net` is the person's window flow (assigned minus evaluated). The bar says how big
// the pile is; net says which way it is moving, and the two together are the reading:
// a big pile that is draining needs nothing, a small pile that is filling needs
// looking at now.
export function QueueBars({ rows, bands, unitName = 'window', staleFrom }: {
  // `warn` marks a row the tab is about to name in an action, so the chart and the
  // "Do this" block point at the same people instead of leaving the reader to work out
  // which of eleven bars the sentence meant.
  rows: Array<{ name: string; n: number; parts: number[]; oldest: number; net: number | null; warn?: boolean }>
  bands: Array<{ label: string; color: string }>
  unitName?: string
  // the age at which a game counts as stale, for the column header
  staleFrom?: number
}) {
  if (rows.length === 0) return <Empty text="The backlog is empty" />
  const max = Math.max(1, ...rows.map((r) => r.n))
  // A band with nothing in it anywhere is not drawn and not listed. On real data the
  // 15d+ band is routinely empty, and four legend swatches for three colours on screen
  // is the reader doing reconciliation the chart should have done.
  const live = bands.map((b, i) => ({ ...b, i })).filter((b) => rows.some((r) => (r.parts[b.i] || 0) > 0))
  return (
    <div className="rp-queue">
      <div className="rp-queue-legend">
        {live.map((b) => (
          <span className="rp-legend-row" key={b.label}>
            <span className="rp-dot" style={{ background: b.color }} />
            <span className="rp-legend-name">{b.label}</span>
          </span>
        ))}
        <span className="rp-queue-legend-note">held since assigned</span>
      </div>
      {/* Four unlabelled numbers in a row is a puzzle: "984 13d +955" gives the reader
          no way to know which is a count, which is an age and which is a change. */}
      <div className="rp-queue-row rp-queue-head" aria-hidden="false">
        <span className="rp-queue-name">Evaluator</span>
        <span className="rp-queue-track-head">Backlog by age held{staleFrom ? ` · ${staleFrom}d+ is stale` : ''}</span>
        <span className="rp-queue-val">Games</span>
        <span className="rp-queue-age">Oldest</span>
        <span className="rp-queue-net">Net this {unitName}</span>
      </div>
      {rows.map((r) => (
        <div className={'rp-queue-row' + (r.warn ? ' warn' : '')} key={r.name}>
          <span className="rp-queue-name" title={r.warn ? `${r.name} - named under "Do this"` : r.name}>
            {r.warn && <span className="rp-queue-flag" aria-label="needs attention">
              <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
                <path d="M6 1.3 11 10.7H1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M6 5v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                <circle cx="6" cy="9.1" r=".65" fill="currentColor" />
              </svg>
            </span>}
            {r.name}
          </span>
          <span className="rp-queue-track">
            <span className="rp-queue-bar" style={{ width: `${(r.n / max) * 100}%` }}>
              {bands.map((b, i) => {
                const v = r.parts[i] || 0
                if (v <= 0) return null
                return (
                  <span key={b.label} className="rp-queue-seg"
                    style={{ width: `${(v / r.n) * 100}%`, background: b.color }}
                    title={`${r.name} · ${fmt.int(v)} held ${b.label}`} />
                )
              })}
            </span>
          </span>
          <span className="rp-queue-val">{fmt.int(r.n)}</span>
          <span className="rp-queue-age" title={`oldest game has waited ${r.oldest} days`}>{r.oldest}d</span>
          {/* Verb-free by design: this is a reading, not an instruction. */}
          <span className={'rp-queue-net ' + (r.net == null ? 'flat' : r.net > 0 ? 'up' : r.net < 0 ? 'down' : 'flat')}
            title={r.net == null ? 'no flow recorded this ' + unitName
              : `took ${fmt.int(Math.max(0, r.net))} more than cleared this ${unitName}`}>
            {r.net == null ? '\u00b7' : r.net === 0 ? 'level' : `${r.net > 0 ? '+' : '\u2212'}${fmt.int(Math.abs(r.net))}`}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------- one sortable table (replaces a wall of single-metric rank boards) ----------
// A rank board answers "who is top at X". Eight of them side by side still cannot
// answer "what is this person like", because the reader has to find one name in eight
// lists and join them up in their head. One table sorted by any column answers both -
// and it puts the count behind every rate in the same cell, which is what stops an
// 8.6% built on 35 games from reading as the best number on the page.
export type SortCol<R> = {
  key: string
  label: string
  // Sort key. null is NOT zero: someone with no assignments has no turnaround, and
  // sorting them in as "0 days" would hand them the top of the fastest-first board.
  // Nulls sink to the bottom in both directions.
  value: (r: R) => number | null
  cell: (r: R) => React.ReactNode
  // the raw counts behind a derived value, set under it
  sub?: (r: R) => React.ReactNode
  tip?: React.ReactNode
  // a column the moderator stamps days later - unreliable while the window is open
  late?: boolean
  // Marks this header cell `data-rp-focus="<focusKey>"` so an action elsewhere on the
  // page can link a reader straight to it (see the shared `focus()` helper).
  focusKey?: string
}

// Two chevrons, drawn rather than typed: ▲▼↕ are font glyphs, so they arrive at a
// different weight and baseline on every machine and some substitute an emoji. Both
// chevrons stay visible so the control reads as sortable before it is touched; the
// live one is tinted.
function SortMark({ dir }: { dir: 'asc' | 'desc' | 'off' }) {
  return (
    <svg className="rp-sortmark" viewBox="0 0 8 12" width="8" height="12" aria-hidden="true" focusable="false">
      <path d="M4 1.2 6.9 5H1.1z" className={dir === 'asc' ? 'on' : undefined} />
      <path d="M4 10.8 1.1 7h5.8z" className={dir === 'desc' ? 'on' : undefined} />
    </svg>
  )
}

export function SortTable<R>({ rows, cols, rowKey, rowName, rowSub, initialSort, inactive, inactiveNote, rowFlash }: {
  rows: R[]
  cols: Array<SortCol<R>>
  rowKey: (r: R) => string
  rowName: (r: R) => React.ReactNode
  rowSub?: (r: R) => React.ReactNode
  initialSort: string
  // Did no work in this window. Still listed - "who is missing" is a reading of this
  // table - but pinned below the ranked block and never given a rank number, because
  // a rank of last implies they competed.
  inactive?: (r: R) => boolean
  inactiveNote?: string
  // A one-shot ring on the rows an incoming `focus=` link is about, same idiom as
  // `rp-flash` elsewhere on the page. The caller decides which rows qualify and for
  // how long; this table only paints the class it is handed.
  rowFlash?: (r: R) => boolean
}) {
  // null = the table's own default. A column cycles largest-first, smallest-first, off,
  // so the third click undoes the sort instead of leaving the reader hunting for which
  // column they touched.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  if (rows.length === 0) return <Empty />
  const eff = sort || { key: initialSort, dir: 'desc' as const }
  const col = cols.find((c) => c.key === eff.key) || cols[0]
  const active = inactive ? rows.filter((r) => !inactive(r)) : rows
  const idle = inactive ? rows.filter((r) => inactive(r)) : []
  const sorted = [...active].sort((a, b) => {
    const va = col.value(a), vb = col.value(b)
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1
    return eff.dir === 'desc' ? vb - va : va - vb
  })
  // Every column starts largest-first, because on every column here the large end is
  // the end worth looking at: most games, longest wait, highest score.
  const click = (key: string) => setSort((s) => {
    if (!s || s.key !== key) return { key, dir: 'desc' }
    return s.dir === 'desc' ? { key, dir: 'asc' } : null
  })
  const dirOf = (key: string): 'desc' | 'asc' | 'off' =>
    sort && sort.key === key ? sort.dir : 'off'
  const body = (r: R, rank: number | null) => (
    <tr key={rowKey(r)} className={[rank == null ? 'rp-lbt-idle' : null, rowFlash?.(r) ? 'rp-flash' : null]
      .filter(Boolean).join(' ') || undefined}>
      <td className="rp-lbt-i">{rank ?? ''}</td>
      <td className="rp-lbt-name">
        {rowName(r)}
        {rowSub && <span className="rp-lbt-namesub">{rowSub(r)}</span>}
      </td>
      {cols.map((c) => (
        <td key={c.key} className={'rp-lbt-num' + (c.key === eff.key ? ' on' : '')}>
          <span className="rp-lbt-v">{c.cell(r)}</span>
          {c.sub && <span className="rp-lbt-sub">{c.sub(r)}</span>}
        </td>
      ))}
    </tr>
  )
  return (
    <div className="rp-lbt-wrap">
      {sort && (
        <div className="rp-lbt-bar">
          <span className="rp-lbt-state">Sorted by {col.label}, {sort.dir === 'desc' ? 'largest first' : 'smallest first'}</span>
          <button className="rp-lbt-reset" onClick={() => setSort(null)}>Reset</button>
        </div>
      )}
      <table className="rp-lbt">
        <thead>
          <tr>
            <th className="rp-lbt-i" />
            <th className="rp-lbt-name">Evaluator</th>
            {cols.map((c) => (
              <th key={c.key} className={'rp-lbt-num' + (c.key === eff.key ? ' on' : '')}
                {...(c.focusKey ? { 'data-rp-focus': c.focusKey } : {})}>
                <button className="rp-lbt-sortbtn" onClick={() => click(c.key)}
                  title={`Sort by ${c.label}`} aria-label={`Sort by ${c.label}`}>
                  {c.label}
                  {c.late && <span className="rp-lbt-late" title="A moderator stamps this days after the evaluation, so an open window reads low">late</span>}
                  <SortMark dir={dirOf(c.key)} />
                </button>
                {c.tip && <InfoTip title={c.label}>{c.tip}</InfoTip>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => body(r, i + 1))}
          {idle.length > 0 && (
            <tr className="rp-lbt-sep">
              <td colSpan={cols.length + 2}>{inactiveNote || 'No activity in this window - not ranked'}</td>
            </tr>
          )}
          {idle.map((r) => body(r, null))}
        </tbody>
      </table>
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
export function HealthBars({ rows, unitName = 'bucket' }: {
  // The bucket noun for the sparkline caption ("per day"). Without it the line is an
  // unnamed shape sitting next to a gauge, and a reader cannot tell whether it is the
  // history of this metric or the history of the target.
  unitName?: string
  rows: Array<{
    label: string; value: string
    detail?: string            // raw counts behind the ratio ("198 of 1,130 assigned")
    pct: number                // fill position 0-100, already scaled against the target
    target?: number            // target marker position 0-100 (omit for "no benchmark")
    targetLabel?: string       // what the marker means ("target 10%")
    delta?: number | null      // change vs previous period, in the metric's own unit
    deltaLabel?: string        // e.g. "pts vs prev week"
    // per-bucket history of the same metric. A gauge is a single moment; the spark
    // says whether that moment is a step in a trend or a one-off wobble.
    spark?: number[]
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
              {r.spark && r.spark.length >= 2 && (
                <Sparkline data={r.spark} color={col[r.status]} w={54} h={16}
                  title={`${r.label} per ${unitName}, across this window`} />
              )}
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
// Two stacked bars per bucket growing out of a shared centre line, on ONE scale so the
// halves are directly comparable. Built for "work done against work that only got
// older": a snapshot chart can show the 8-14d pile shrinking without saying whether
// those games were judged or turned 15d+, and this puts both on the same row.
export function DivergingBars({ rows, leftKeys, rightKeys, colors, leftLabel, rightLabel }: {
  rows: Array<{ name: string; left: Record<string, number>; right: Record<string, number> }>
  leftKeys: string[]; rightKeys: string[]
  colors?: Record<string, string>
  leftLabel: string; rightLabel: string
}) {
  const colorOf = (k: string, i: number) => colors?.[k] || conclusionColor(k, i)
  const [hover, setHover] = useState<string | null>(null)
  const [seg, setSeg] = useState<{ name: string; k: string; v: number; side: string } | null>(null)
  if (rows.length === 0) return <Empty />
  const sum = (o: Record<string, number>, ks: string[]) => ks.reduce((s, k) => s + (o[k] || 0), 0)
  const lTot = rows.map((r) => sum(r.left, leftKeys))
  const rTot = rows.map((r) => sum(r.right, rightKeys))
  // one scale for both sides - two scales would let a small bar out-draw a big one,
  // which is the whole comparison this chart exists to make
  const max = Math.max(1, ...lTot, ...rTot)
  const half = (keys: string[], parts: Record<string, number>, name: string, side: string, flip: boolean) => (
    <span className={'rp-div-track' + (flip ? ' flip' : '')}>
      {keys.map((k, i) => {
        const v = parts[k] || 0
        if (!v) return null
        return <span key={k} className="rp-stack-seg"
          onMouseEnter={() => { setHover(k); setSeg({ name, k, v, side }) }}
          onMouseLeave={() => { setHover(null); setSeg(null) }}
          style={{ width: `${(v / max) * 100}%`, background: colorOf(k, i), opacity: hover && hover !== k ? 0.3 : 1 }} />
      })}
    </span>
  )
  return (
    <div>
      <div className="rp-div-heads">
        <span className="left">◀ {leftLabel}</span>
        <span className="right">{rightLabel} ▶</span>
      </div>
      <div className="rp-stack-info">
        {seg ? (
          <>
            <span className="rp-dot" style={{ background: colorOf(seg.k, 0) }} />
            <span>{seg.name} · <b>{fmt.int(seg.v)}</b> {seg.side} {seg.k}</span>
          </>
        ) : <span style={{ opacity: .55 }}>Hover a segment for exact counts</span>}
      </div>
      <div className="rp-div">
        {rows.map((r, ri) => (
          <div className="rp-div-row" key={r.name}>
            <span className="rp-div-num left">{lTot[ri] ? fmt.int(lTot[ri]) : ''}</span>
            {half(leftKeys, r.left, r.name, leftLabel.toLowerCase(), true)}
            <span className="rp-div-name" title={r.name}>{r.name}</span>
            {half(rightKeys, r.right, r.name, rightLabel.toLowerCase(), false)}
            <span className="rp-div-num right">{rTot[ri] ? fmt.int(rTot[ri]) : ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
