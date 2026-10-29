// lib/effort-game-time.ts — grouping panel time per person, per VN day, per game.
import { groupGameTime, type GameTimeRow } from '@/lib/effort-game-time'
import type { RecordRow } from '@/lib/effort-sessions'

const abc = { employee_id: 'abc', name: 'AbcXY' }
const row = (o: Partial<GameTimeRow>): GameTimeRow => ({
  person_key: 'abcxy', date: '2026-10-26', game_id: 'g1', game: 'G1', genre: 'puzzle', duration_s: 60, ...o,
})
const rec = (o: Partial<RecordRow>): RecordRow => ({
  assignee_key: 'abcxy', date: '2026-10-26', time: '09:00:00', game_id: 'r1', game: 'R1', genre: 'puzzle', duration_min: 5, ...o,
})

describe('groupGameTime', () => {
  it('keeps every requested person, even with no days', () => {
    const out = groupGameTime([abc, { employee_id: 'idle', name: 'Idle' }], [row({})], [])
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ employee_id: 'idle', name: 'Idle', days: [] })
  })

  it('lists one entry per game per day with only its duration', () => {
    const [p] = groupGameTime([abc], [row({ duration_s: 700 }), row({ game_id: 'g2', game: 'G2', duration_s: 50 })], [])
    expect(p.days).toHaveLength(1)
    expect(p.days[0].games).toEqual([
      { game_id: 'g1', game: 'G1', genre: 'puzzle', duration_s: 700 },
      { game_id: 'g2', game: 'G2', genre: 'puzzle', duration_s: 50 },
    ])
  })

  // 495 games still have a row in two genres. A person who judged both rows of one game
  // must not show up twice on the same day.
  it('merges two rows of the same game on the same day, and takes the genre of the longer one', () => {
    const [p] = groupGameTime([abc], [
      row({ genre: 'arcade', duration_s: 30 }),
      row({ genre: 'puzzle', duration_s: 120 }),
    ], [])
    expect(p.days[0].games).toEqual([{ game_id: 'g1', game: 'G1', genre: 'puzzle', duration_s: 150 }])
  })

  it('reports null, not 0, when nothing was measured for the game that day', () => {
    const [p] = groupGameTime([abc], [row({ duration_s: null })], [])
    expect(p.days[0].games[0].duration_s).toBeNull()
  })

  it('a measured row wins over an unmeasured one for the same game and day', () => {
    const [p] = groupGameTime([abc], [row({ duration_s: null }), row({ duration_s: 80 })], [])
    expect(p.days[0].games[0].duration_s).toBe(80)
  })

  it('splits a game worked on two days into two entries', () => {
    const [p] = groupGameTime([abc], [row({ duration_s: 100 }), row({ date: '2026-10-27', duration_s: 40 })], [])
    expect(p.days.map(d => [d.date, d.games[0].duration_s])).toEqual([['2026-10-26', 100], ['2026-10-27', 40]])
  })

  it('keeps the first genre it finds when no row has any time', () => {
    const [p] = groupGameTime([abc], [row({ genre: null, duration_s: null }), row({ genre: 'arcade', duration_s: null })], [])
    expect(p.days[0].games[0].genre).toBe('arcade')
  })

  it('puts records on their own day, with the 5 and 20 minute counts', () => {
    const [p] = groupGameTime([abc], [row({})], [
      rec({ game_id: 'r1', duration_min: 5 }),
      rec({ game_id: 'r2', duration_min: 5 }),
      rec({ game_id: 'r3', duration_min: 20 }),
      rec({ date: '2026-10-25', game_id: 'r4', duration_min: 20 }),
    ])
    expect(p.days.map(d => d.date)).toEqual(['2026-10-25', '2026-10-26'])
    expect(p.days[0]).toEqual({
      date: '2026-10-25', games: [], records_5min: 0, records_20min: 1,
      records: [{ time: '09:00:00', game_id: 'r4', game: 'R1', genre: 'puzzle', duration_min: 20 }],
    })
    expect(p.days[1].records_5min).toBe(2)
    expect(p.days[1].records_20min).toBe(1)
    expect(p.days[1].records.map(r => r.game_id)).toEqual(['r1', 'r2', 'r3'])
  })

  it('ignores rows for people who were not asked for', () => {
    const [p] = groupGameTime([abc], [row({ person_key: 'someone-else' })], [rec({ assignee_key: 'someone-else' })])
    expect(p.days).toEqual([])
  })
})
