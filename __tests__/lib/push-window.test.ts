import {
  DEFAULT_PUSH_WINDOW, DEFAULT_PUSH_WINDOW_CONFIG, PUSH_WINDOWS, PUSH_WINDOW_NOTE,
  isPushWindow, parsePushWindowConfig, pushWindowFor,
} from '@/lib/push-window'
import { BUCKETS } from '@/lib/buckets'

describe('push window config', () => {
  it('offers exactly 3, 7, 14 and 30 days', () => {
    expect(PUSH_WINDOWS).toEqual([3, 7, 14, 30])
  })

  it('defaults every genre to 30 days, so enabling the feature changes nothing', () => {
    expect(DEFAULT_PUSH_WINDOW).toBe(30)
    for (const b of BUCKETS) expect(DEFAULT_PUSH_WINDOW_CONFIG[b]).toBe(30)
  })

  it('accepts only the offered values', () => {
    for (const v of PUSH_WINDOWS) expect(isPushWindow(v)).toBe(true)
    for (const v of [0, 1, 2, 15, 31, 45, 365, -7, '7', null, undefined, NaN]) {
      expect(isPushWindow(v)).toBe(false)
    }
  })

  it('reads a stored blob per genre', () => {
    const cfg = parsePushWindowConfig('{"puzzle":7,"arcade":14,"simulation":3}')
    expect(cfg).toEqual({ puzzle: 7, arcade: 14, simulation: 3 })
  })

  it('fills the genres a partial blob leaves out', () => {
    const cfg = parsePushWindowConfig('{"puzzle":3}')
    expect(cfg.puzzle).toBe(3)
    expect(cfg.arcade).toBe(30)
    expect(cfg.simulation).toBe(30)
  })

  it('ignores an off-scale value rather than clamping it', () => {
    // A stored 45 means the blob was hand-edited. Guessing at 30 or at 14 would
    // be silent either way; the default at least shows up as the default in the
    // UI, where somebody notices.
    expect(parsePushWindowConfig('{"puzzle":45}').puzzle).toBe(30)
  })

  it('survives junk, because the daily push must not stop for this row', () => {
    for (const raw of ['', null, undefined, 'not json', '[]', '{"puzzle":"7"}', '{"nope":7}']) {
      expect(parsePushWindowConfig(raw)).toEqual(DEFAULT_PUSH_WINDOW_CONFIG)
    }
  })

  it('pushWindowFor falls back for a genre missing from the blob', () => {
    const cfg = { puzzle: 7 } as never
    expect(pushWindowFor(cfg, 'puzzle')).toBe(7)
    expect(pushWindowFor(cfg, 'arcade')).toBe(30)
  })

  it('states what the window measures, in words the UI can show', () => {
    // "30 days" of what is the whole question; the answer must not live only in
    // a code comment.
    expect(PUSH_WINDOW_NOTE).toMatch(/release date/i)
    expect(PUSH_WINDOW_NOTE).toMatch(/no release date/i)
    expect(PUSH_WINDOW_NOTE).toMatch(/first saw/i)
  })
})
