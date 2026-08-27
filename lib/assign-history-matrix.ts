// lib/assign-history-matrix.ts — pivot assignment_history thành matrix ngày × người.
//
// Hai luật không được vi phạm, vì vi phạm là matrix nói dối:
//  1. Số "assign" không bao giờ gộp reassign/handover vào. Một game bị reassign
//     đã được đếm một lần ở lần assign gốc; cộng lại là đếm hai.
//  2. Cột là ngày liên tục theo lịch, không phải chỉ ngày có data. Giá trị của
//     matrix nằm ở những ô trống — ngày cả team không nhận gì là thông tin.

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

export interface Totals { assign: number; reassign: number; handover: number }
export interface Cell extends Totals { rows: HistoryRow[] }
export interface MatrixRow { name: string; inRoster: boolean; cells: Cell[]; total: Totals }
export interface Matrix { days: string[]; rows: MatrixRow[]; dayTotals: Totals[]; grandTotal: Totals }

const DAY_MS = 86_400_000

const zero = (): Totals => ({ assign: 0, reassign: 0, handover: 0 })
const emptyCell = (): Cell => ({ ...zero(), rows: [] })
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

function actionOf(r: HistoryRow): keyof Totals {
  return r.action === 'reassign' || r.action === 'handover' ? r.action : 'assign'
}

function add(t: Totals, r: HistoryRow): void {
  t[actionOf(r)] += r.game_count || 0
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

  // Roster hiện tại trước (kể cả người 0 history — đó là thứ cần thấy), rồi
  // những người chỉ còn tồn tại trong history.
  const inRoster = new Set(input.rosterNames)
  const names: string[] = []
  const seen = new Set<string>()
  for (const n of [...input.rosterNames].sort(byName)) {
    if (!seen.has(n)) { seen.add(n); names.push(n) }
  }
  for (const n of Array.from(new Set(input.rows.map(r => r.evaluator_name))).sort(byName)) {
    if (!seen.has(n)) { seen.add(n); names.push(n) }
  }

  const rowByName = new Map<string, MatrixRow>(names.map(n => [n, {
    name: n,
    inRoster: inRoster.has(n),
    cells: days.map(() => emptyCell()),
    total: zero(),
  }]))
  const dayTotals = days.map(() => zero())
  const grandTotal = zero()

  for (const r of input.rows) {
    const i = dayIndex.get(r.run_date.slice(0, 10))
    if (i === undefined) continue
    const mr = rowByName.get(r.evaluator_name)
    if (!mr) continue
    add(mr.cells[i], r)
    mr.cells[i].rows.push(r)
    add(mr.total, r)
    add(dayTotals[i], r)
    add(grandTotal, r)
  }

  return { days, rows: names.map(n => rowByName.get(n)!), dayTotals, grandTotal }
}

// Đậm nhạt theo quantile TRONG cửa sổ đang xem, không dùng thang tuyệt đối:
// pool mỗi ngày to nhỏ khác nhau nên một thang cố định sẽ sai liên tục.
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
