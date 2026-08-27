// lib/assign-history-matrix.ts — pivots assignment_history into a day x person
// matrix.
//
// The matrix is a NET ledger, not an assign counter. When a game moves from A to
// B, B gains it and A loses it, and both sides land on the day the move happened
// even though the game was originally assigned to A on some earlier day. That is
// the point: "who is holding how much, and what changed today" is the question
// the grid answers, and it cannot answer it if a move only ever shows up as a
// gain. A day's column still nets out to the games assigned that day, because
// every move's + and - cancel inside the column.
//
// The other rule: columns are consecutive calendar days, not just days that have
// data. The empty cells are the information — a day nobody got a game is a fact.

export interface HistoryRow {
  id: number
  run_date: string
  run_at: string
  category_group: string
  action: 'assign' | 'reassign' | 'handover'
  evaluator_name: string
  from_evaluator: string | null
  game_count: number
  created_by: string | null
}

export interface Totals {
  assign: number
  reassignIn: number
  reassignOut: number
  handoverIn: number
  handoverOut: number
  net: number
}

/** One history row seen from one person's side. */
export interface Entry { row: HistoryRow; dir: 'in' | 'out' }

export interface Cell extends Totals { entries: Entry[] }
export interface MatrixRow { name: string; inRoster: boolean; cells: Cell[]; total: Totals }
export interface Matrix { days: string[]; rows: MatrixRow[]; dayTotals: Totals[]; grandTotal: Totals }

const DAY_MS = 86_400_000

const zero = (): Totals => ({
  assign: 0, reassignIn: 0, reassignOut: 0, handoverIn: 0, handoverOut: 0, net: 0,
})
const emptyCell = (): Cell => ({ ...zero(), entries: [] })
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

/** Games landing on the person named by `evaluator_name`. */
function credit(t: Totals, r: HistoryRow): void {
  const n = r.game_count || 0
  if (r.action === 'reassign') t.reassignIn += n
  else if (r.action === 'handover') t.handoverIn += n
  else t.assign += n
  t.net += n
}

/** Games leaving the person named by `from_evaluator`. Never an 'assign'. */
function debit(t: Totals, r: HistoryRow): void {
  const n = r.game_count || 0
  if (r.action === 'handover') t.handoverOut += n
  else t.reassignOut += n
  t.net -= n
}

export function dayRange(from: string, to: string): string[] {
  const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) return []
  const days: string[] = []
  for (let t = start; t <= end; t += DAY_MS) days.push(iso(t))
  return days
}

export function shiftWindow(from: string, to: string, days: number): { from: string; to: string } {
  const shift = days * DAY_MS
  return {
    from: iso(Date.parse(`${from.slice(0, 10)}T00:00:00Z`) + shift),
    to: iso(Date.parse(`${to.slice(0, 10)}T00:00:00Z`) + shift),
  }
}

export function buildMatrix(input: {
  rows: HistoryRow[]
  from: string
  to: string
  rosterNames: string[]
}): Matrix {
  const days = dayRange(input.from, input.to)
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const inWindow = input.rows.filter(r => dayIndex.has(r.run_date.slice(0, 10)))

  // Every name that needs a row: the current roster (including people with no
  // history at all — a row of dots is what makes them visible), plus anyone who
  // received or gave away games inside the window.
  const inRoster = new Set(input.rosterNames)
  const names = new Set<string>(input.rosterNames)
  for (const r of inWindow) {
    names.add(r.evaluator_name)
    if (r.from_evaluator) names.add(r.from_evaluator)
  }

  const rowByName = new Map<string, MatrixRow>(Array.from(names, n => [n, {
    name: n,
    inRoster: inRoster.has(n),
    cells: days.map(() => emptyCell()),
    total: zero(),
  }]))
  const dayTotals = days.map(() => zero())
  const grandTotal = zero()

  for (const r of inWindow) {
    const i = dayIndex.get(r.run_date.slice(0, 10))!

    const to = rowByName.get(r.evaluator_name)
    if (to) {
      credit(to.cells[i], r)
      to.cells[i].entries.push({ row: r, dir: 'in' })
      credit(to.total, r)
      credit(dayTotals[i], r)
      credit(grandTotal, r)
    }

    // The giving side of a move, booked on the day of the move.
    if (r.from_evaluator && r.action !== 'assign') {
      const from = rowByName.get(r.from_evaluator)
      if (from) {
        debit(from.cells[i], r)
        from.cells[i].entries.push({ row: r, dir: 'out' })
        debit(from.total, r)
        debit(dayTotals[i], r)
        debit(grandTotal, r)
      }
    }
  }

  // Busiest first: the grid is read to find who is carrying the load.
  const rows = Array.from(rowByName.values())
    .sort((a, b) => (b.total.net - a.total.net) || byName(a.name, b.name))

  return { days, rows, dayTotals, grandTotal }
}

// Shading follows quantiles WITHIN the visible window rather than an absolute
// scale: the daily pool size swings, so a fixed scale would be wrong most days.
export function shadeScale(values: number[]): (n: number) => 0 | 1 | 2 | 3 | 4 {
  const nz = values.filter(v => v > 0).sort((a, b) => a - b)
  if (nz.length === 0) return () => 0
  const q = (p: number) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))]
  const q1 = q(0.25)
  const q2 = q(0.5)
  const q3 = q(0.75)
  return (n: number) => {
    if (n <= 0) return 0
    if (n <= q1) return 1
    if (n <= q2) return 2
    if (n <= q3) return 3
    return 4
  }
}
