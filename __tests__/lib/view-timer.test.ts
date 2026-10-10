import { startView, onVisibility, onInput, snapshot, restartAfterSave, IDLE_GAP_MS } from '@/lib/view-timer'

const S = 1000
describe('view timer', () => {
  it('measures seconds since the game was shown', () => {
    const t = startView('A', 0, false)
    expect(snapshot(t, 'A', 42 * S)).toEqual({ gameId: 'A', at: 42 * S, view_s: 42, hidden_s: 0, idle_s: 0 })
  })

  it('returns null for a game other than the one being timed (stale ev)', () => {
    expect(snapshot(startView('B', 0, false), 'A', 10 * S)).toBeNull()
  })

  it('adds hidden stretches, including one still open at the snapshot', () => {
    let t = startView('A', 0, false)
    t = onVisibility(t, true, 10 * S)
    t = onVisibility(t, false, 30 * S)
    t = onVisibility(t, true, 50 * S)
    expect(snapshot(t, 'A', 60 * S)!.hidden_s).toBe(30)
  })

  it('counts only input gaps longer than 2 minutes as idle, measured from the start', () => {
    let t = startView('A', 0, false)
    t = onInput(t, 60 * S)                       // 60 s gap: not idle
    t = onInput(t, 60 * S + IDLE_GAP_MS + S)     // 121 s gap: idle
    expect(snapshot(t, 'A', 200 * S)!.idle_s).toBe(121)
  })

  it('counts a trailing quiet stretch at save time as idle', () => {
    expect(snapshot(startView('A', 0, false), 'A', 300 * S)!.idle_s).toBe(300)
  })

  it('never reports hidden or idle above view', () => {
    let t = startView('A', 0, true)                // hidden from the start
    const s = snapshot(t, 'A', 500 * S)!
    expect(s.hidden_s).toBeLessThanOrEqual(s.view_s)
    expect(s.idle_s).toBeLessThanOrEqual(s.view_s)
  })

  it('restarts at the snapshot time after a successful save of the same game', () => {
    const t = startView('A', 0, false)
    const snap = snapshot(t, 'A', 40 * S)!
    const r = restartAfterSave(t, snap, false)
    expect(snapshot(r, 'A', 70 * S)!.view_s).toBe(30) // contiguous with the first save
  })

  it('does not touch the timer when the user already moved to another game', () => {
    const t = startView('A', 0, false)
    const snap = snapshot(t, 'A', 40 * S)!
    const moved = startView('B', 41 * S, false)
    expect(restartAfterSave(moved, snap, false)).toBe(moved)
  })

  it('does not rewind a timer that restarted after the snapshot (A -> B -> A)', () => {
    const snap = snapshot(startView('A', 0, false), 'A', 40 * S)!
    const back = startView('A', 50 * S, false)
    expect(restartAfterSave(back, snap, false)).toBe(back)
  })
})
