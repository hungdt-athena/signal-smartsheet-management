// Fixture chỉ cho page giả lập /team-ops/assign-preview. Xoá cùng page đó.
import type { RosterRow } from '@/lib/assign-roster'
import type { HistoryRow } from '@/lib/assign-history-matrix'

const r = (
  id: number, name: string, category_group: RosterRow['category_group'],
  o: Partial<RosterRow> = {},
): RosterRow => ({
  id, name, category_group, today_available: true,
  game_platform: 'all', game_category: 'All', weight: 100, ...o,
})

export const FIXTURE_INITIAL: RosterRow[] = [
  r(1, 'NhiLV', 'puzzle'),
  r(2, 'NhiLV', 'arcade', { game_platform: 'ios', game_category: 'action', weight: 50 }),
  r(3, 'MyTL', 'puzzle'),
  r(4, 'MiTT', 'puzzle', { weight: 50 }),
  r(5, 'MiTT', 'arcade', { weight: 50 }),
  r(6, 'MiTT', 'simulation', { game_category: 'strategy', weight: 30 }),
  r(7, 'GabrielTran', 'puzzle', { today_available: false, game_platform: 'ios', weight: 30 }),
  r(8, 'HuyDD', 'puzzle'),
  r(9, 'KietCD', 'arcade', { game_platform: 'android', weight: 50 }),
]

export const FIXTURE_FINAL: RosterRow[] = [
  r(20, 'ThuDT', 'puzzle'),
  r(21, 'PhuongNT1', 'puzzle', { game_platform: 'ios' }),
]

export const FIXTURE_SUB_GENRES = {
  puzzle: ['puzzle', 'word', 'trivia', 'music', 'casual'],
  arcade: ['arcade', 'adventure', 'action'],
  simulation: ['simulation', 'strategy'],
}

export const FIXTURE_WINDOW = { from: '2026-08-14', to: '2026-08-27' }

// 20/8 cố tình trống hết. 25/8 có một reassign. KietCD không có dòng nào.
export const FIXTURE_HISTORY: HistoryRow[] = (() => {
  const out: HistoryRow[] = []
  const days = ['2026-08-18', '2026-08-19', '2026-08-21', '2026-08-22', '2026-08-25', '2026-08-26', '2026-08-27']
  const per: Record<string, number> = { NhiLV: 4, MyTL: 4, MiTT: 2, HuyDD: 4 }
  let id = 1
  for (const d of days) {
    for (const [name, n] of Object.entries(per)) {
      if (d === '2026-08-19' && name === 'HuyDD') continue
      out.push({
        id: id++, run_date: d, run_at: `${d}T09:00:00Z`, category_group: 'puzzle',
        action: 'assign', evaluator_name: name, from_evaluator: null,
        game_count: d === '2026-08-22' ? n + 2 : n, created_by: 'cron',
      })
    }
  }
  out.push({
    id: id++, run_date: '2026-08-25', run_at: '2026-08-25T14:20:00Z', category_group: 'puzzle',
    action: 'reassign', evaluator_name: 'MiTT', from_evaluator: 'HuyDD',
    game_count: 1, created_by: 'KhangNA',
  })
  return out
})()
