import {
  readTiming, touchedFlags, logKindSql, isMissingLogTable, EVALUATION_LOG_MISSING,
} from '@/lib/evaluation-log'

describe('readTiming', () => {
  it('is "other" with no timing when view_s is absent', () => {
    expect(readTiming({ id: 1, final_note: 'x' })).toEqual({
      source: 'other', context: null, viewS: null, hiddenS: null, idleS: null,
    })
  })
  it('is "other" when view_s is not a finite number', () => {
    expect(readTiming({ view_s: '30' }).source).toBe('other')
    expect(readTiming({ view_s: NaN }).source).toBe('other')
  })
  it('is "panel" and clamps view_s to [0, 86400]', () => {
    expect(readTiming({ view_s: -5 }).viewS).toBe(0)
    expect(readTiming({ view_s: 90000 }).viewS).toBe(86400)
    expect(readTiming({ view_s: 12.6 }).viewS).toBe(13)
  })
  it('clamps hidden_s and idle_s to view_s', () => {
    const t = readTiming({ view_s: 100, hidden_s: 500, idle_s: 40 })
    expect(t.hiddenS).toBe(100)
    expect(t.idleS).toBe(40)
  })
  it('accepts only known contexts', () => {
    expect(readTiming({ view_s: 1, context: 'record' }).context).toBe('record')
    expect(readTiming({ view_s: 1, context: 'hack' }).context).toBeNull()
  })
})

describe('touchedFlags', () => {
  it('sees an initial field', () => {
    expect(touchedFlags({ id: 1, initial_note_parts: {} })).toEqual({ initialTouched: true, finalTouched: false })
    expect(touchedFlags({ id: 1, drive_link: '' })).toEqual({ initialTouched: true, finalTouched: false })
  })
  it('sees a final-only write', () => {
    expect(touchedFlags({ id: 1, final_conclusion: 'Insight' })).toEqual({ initialTouched: false, finalTouched: true })
  })
  it('sees a record-only write as neither', () => {
    expect(touchedFlags({ id: 1, record_5min_drive: 'x' })).toEqual({ initialTouched: false, finalTouched: false })
  })
})

describe('logKindSql', () => {
  const tag = (strings: TemplateStringsArray, ...binds: unknown[]) => ({ text: strings.join('$'), binds })
  it('binds both flags and reads old/upd', () => {
    const f = logKindSql(tag as never, { initialTouched: true, finalTouched: false }) as unknown as { text: string; binds: unknown[] }
    expect(f.binds).toEqual([true, false, true]) // initialTouched, finalTouched, initialTouched
    expect(f.text).toMatch(/old\.evaluate_date IS NULL/)
    expect(f.text).toMatch(/'Stale_release'/)
    expect(f.text).toMatch(/THEN 'clear'/)
  })
})

describe('isMissingLogTable', () => {
  it('matches 42P01 on evaluation_log only', () => {
    expect(isMissingLogTable({ code: '42P01', message: 'relation "evaluation_log" does not exist' })).toBe(true)
    expect(isMissingLogTable({ code: '42P01', message: 'relation "other" does not exist' })).toBe(false)
    expect(isMissingLogTable(new Error('x'))).toBe(false)
    expect(EVALUATION_LOG_MISSING).toMatch(/046/)
  })
})
