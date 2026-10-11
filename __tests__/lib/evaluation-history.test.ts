import {
  fromLog, fromAssign, mergeHistory, fmtDuration, summarize, groupByDay, fmtClock,
  type LogRow, type AssignRow,
} from '@/lib/evaluation-history'

const log = (o: Partial<LogRow>): LogRow => ({
  id: '1', at: '2026-10-11T07:32:00.000Z', actor: 'Alice', owner: 'Alice', source: 'panel', context: 'evaluate',
  kind: 'first', conclusion_before: null, conclusion_after: 'Bypass', final_before: null, final_after: null,
  batch_before: null, batch_after: null, changed: true, view_s: 480, confidence: null, ...o,
})
const asg = (o: Partial<AssignRow>): AssignRow => ({
  id: 7, at: '2026-10-10T02:00:00.000Z', action: 'reassign', evaluator_name: 'Alice', from_evaluator: 'Bob', by: 'cron', ...o,
})

describe('fmtDuration', () => {
  it('shows seconds under a minute, minutes under an hour, then hours and minutes', () => {
    expect(fmtDuration(42)).toBe('42s')
    expect(fmtDuration(480)).toBe('8m')
    expect(fmtDuration(3900)).toBe('1h 05m')
  })
})

describe('fromLog', () => {
  it('a first save is "evaluated" with the verdict and the panel time', () => {
    expect(fromLog(log({}))).toEqual({
      key: 'log-1', at: '2026-10-11T07:32:00.000Z', who: 'Alice', type: 'save', verb: 'evaluated',
      changes: [{ kind: 'initial', from: null, to: 'Bypass' }], time: '8m', seconds: 480, note: null,
    })
  })
  it('a first save on a game that already carried a conclusion shows before → after', () => {
    const e = fromLog(log({ conclusion_before: 'Stale_release', conclusion_after: 'Bypass' }))
    expect(e.changes).toEqual([{ kind: 'initial', from: 'Stale_release', to: 'Bypass' }])
  })
  it('a changed verdict shows before → after', () => {
    const e = fromLog(log({ kind: 'revise', conclusion_before: 'Bypass', conclusion_after: 'List_Idea' }))
    expect(e.verb).toBe('changed the verdict')
    expect(e.changes).toEqual([{ kind: 'initial', from: 'Bypass', to: 'List_Idea' }])
  })
  it('a save that keeps the verdict is "edited" and shows the verdict once', () => {
    const e = fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass' }))
    expect(e.verb).toBe('edited the evaluation')
    expect(e.changes).toEqual([{ kind: 'initial', from: null, to: 'Bypass' }])
  })
  it('adds the final conclusion change when it moved alongside the verdict', () => {
    const e = fromLog(log({ kind: 'revise', conclusion_before: 'Bypass', conclusion_after: 'List_Idea', final_before: null, final_after: 'Priority I' }))
    expect(e.changes).toEqual([
      { kind: 'initial', from: 'Bypass', to: 'List_Idea' },
      { kind: 'final', from: null, to: 'Priority I' },
    ])
  })
  it('a final-only save is type final and shows only the final change', () => {
    const e = fromLog(log({ kind: 'final', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', final_before: null, final_after: 'Priority I' }))
    expect(e.type).toBe('final')
    expect(e.verb).toBe('set the final conclusion')
    expect(e.changes).toEqual([{ kind: 'final', from: null, to: 'Priority I' }])
    const again = fromLog(log({ kind: 'final', changed: false, final_before: 'Priority II', final_after: 'Priority I' }))
    expect(again.verb).toBe('changed the final conclusion')
  })
  it('a clear shows the old verdict going to nothing', () => {
    const e = fromLog(log({ kind: 'clear', conclusion_before: 'Bypass', conclusion_after: null }))
    expect(e.verb).toBe('cleared the verdict')
    expect(e.changes).toEqual([{ kind: 'initial', from: 'Bypass', to: null }])
  })
  it('a save that touched neither verdict nor final has no changes', () => {
    const e = fromLog(log({ kind: 'other', changed: false, conclusion_before: null, conclusion_after: null }))
    expect(e.verb).toBe('updated the game')
    expect(e.changes).toEqual([])
  })
  it('appends a batch change as the last line', () => {
    const e = fromLog(log({ kind: 'revise', conclusion_before: 'Bypass', conclusion_after: 'List_Idea', final_before: null, final_after: 'Priority I',
      batch_before: 'W1 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e.verb).toBe('changed the verdict')
    expect(e.changes).toEqual([
      { kind: 'initial', from: 'Bypass', to: 'List_Idea' },
      { kind: 'final', from: null, to: 'Priority I' },
      { kind: 'batch', from: 'W1 Oct, 2026', to: 'W2 Oct, 2026' },
    ])
  })
  it('a save that only moves the batch is "changed the batch" with no verdict chip', () => {
    const e = fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass',
      batch_before: 'W1 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e.verb).toBe('changed the batch')
    expect(e.changes).toEqual([{ kind: 'batch', from: 'W1 Oct, 2026', to: 'W2 Oct, 2026' }])
  })
  it('a batch set for the first time has no "from"', () => {
    const e = fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', batch_before: null, batch_after: 'W2 Oct, 2026' }))
    expect(e.changes).toEqual([{ kind: 'batch', from: null, to: 'W2 Oct, 2026' }])
  })
  it('keeps "edited the evaluation" and the verdict when the batch moved together with the final conclusion', () => {
    const e = fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', final_before: null, final_after: 'Priority I',
      batch_before: 'W1', batch_after: 'W2' }))
    expect(e.verb).toBe('edited the evaluation')
    expect(e.changes.map(c => c.kind)).toEqual(['initial', 'final', 'batch'])
  })
  it('a final-only save with a batch move shows the final change, then the batch', () => {
    const e = fromLog(log({ kind: 'final', changed: false, final_before: null, final_after: 'Priority I', batch_before: 'W1', batch_after: 'W2' }))
    expect(e.verb).toBe('set the final conclusion')
    expect(e.changes.map(c => c.kind)).toEqual(['final', 'batch'])
  })
  it('adds no batch line when the batch is equal, NULL or not', () => {
    expect(fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', batch_before: 'W2', batch_after: 'W2' })).changes.map(c => c.kind)).toEqual(['initial'])
    expect(fromLog(log({ batch_before: null, batch_after: null })).changes.map(c => c.kind)).toEqual(['initial'])
  })
  it('names the tab when the save came from another panel than Evaluate', () => {
    expect(fromLog(log({ context: 'shortlist' })).note).toBe('From Short List')
    expect(fromLog(log({ context: 'record' })).note).toBe('From Record')
    expect(fromLog(log({ context: 'tagging' })).note).toBe('From Tagging')
    expect(fromLog(log({ context: 'evaluate' })).note).toBeNull()
  })
  it('a save without panel timing has no time', () => {
    const e = fromLog(log({ source: 'other', view_s: null, context: null }))
    expect(e.time).toBeNull()
    expect(e.seconds).toBeNull()
  })
  it('an add-to-record pull is its own type and never timed', () => {
    const e = fromLog(log({ source: 'add_to_record', view_s: null, context: null, conclusion_before: 'Bypass', conclusion_after: 'List_Idea' }))
    expect(e).toMatchObject({ type: 'record', verb: 'added to record', time: null, seconds: null })
    expect(e.changes).toEqual([{ kind: 'initial', from: 'Bypass', to: 'List_Idea' }])
  })
  it('an add-to-record pull that moved the batch shows it after the verdict', () => {
    const e = fromLog(log({ source: 'add_to_record', view_s: null, context: null, conclusion_before: 'List_Idea', conclusion_after: 'List_Idea', changed: false,
      batch_before: 'W1 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e.verb).toBe('added to record')
    expect(e.changes).toEqual([
      { kind: 'initial', from: null, to: 'List_Idea' },
      { kind: 'batch', from: 'W1 Oct, 2026', to: 'W2 Oct, 2026' },
    ])
  })
  it('a seed row is an old verdict credited to the owner, with a warning when its time is unsure', () => {
    const ok = fromLog(log({ source: 'seed', actor: null, owner: 'Carol', view_s: null, context: null, confidence: 'ok' }))
    expect(ok).toMatchObject({ who: 'Carol', type: 'seed', verb: 'evaluated', time: null, note: 'Copied from the old record' })
    expect(ok.changes).toEqual([{ kind: 'initial', from: null, to: 'Bypass' }])
    const low = fromLog(log({ source: 'seed', actor: null, owner: 'Carol', view_s: null, context: null, confidence: 'low' }))
    expect(low.note).toBe('Copied from the old record · time may be off')
    // a seed row never shows a batch line, even if the columns were somehow filled
    expect(fromLog(log({ source: 'seed', actor: null, view_s: null, confidence: 'ok', batch_before: 'W1', batch_after: 'W2' })).changes)
      .toEqual([{ kind: 'initial', from: null, to: 'Bypass' }])
    expect(fromLog(log({ source: 'seed', actor: null, view_s: null, confidence: 'corrected' })).note)
      .toBe('Copied from the old record · time taken from the first trend tag')
  })
  it('accepts a Date for at (postgres.js returns timestamptz as Date)', () => {
    expect(fromLog(log({ at: new Date('2026-10-11T07:32:00Z') })).at).toBe('2026-10-11T07:32:00.000Z')
  })
})

describe('fromAssign', () => {
  it('a reassign shows from → to and who ran it', () => {
    expect(fromAssign(asg({}))).toEqual({
      key: 'asg-7', at: '2026-10-10T02:00:00.000Z', who: 'Auto-assign', type: 'assign', verb: 'reassigned',
      changes: [{ kind: 'person', from: 'Bob', to: 'Alice' }], time: null, seconds: null, note: null,
    })
  })
  it('an assign has no source person', () => {
    const e = fromAssign(asg({ action: 'assign', from_evaluator: null, by: 'HungDT' }))
    expect(e).toMatchObject({ who: 'HungDT', verb: 'assigned to' })
    expect(e.changes).toEqual([{ kind: 'person', from: null, to: 'Alice' }])
  })
  it('words rescue and handover too', () => {
    expect(fromAssign(asg({ action: 'rescue' })).verb).toBe('rescued')
    expect(fromAssign(asg({ action: 'handover' })).verb).toBe('handed over')
  })
  it('falls back to a dash when nobody is recorded', () => {
    expect(fromAssign(asg({ by: null })).who).toBe('—')
  })
})

describe('mergeHistory', () => {
  it('puts both sources in one list, newest first', () => {
    const out = mergeHistory(
      [log({ id: '1', at: '2026-10-11T07:10:00Z' }), log({ id: '2', at: '2026-10-11T07:32:00Z' })],
      [asg({ id: 7, at: '2026-10-10T02:00:00Z' }), asg({ id: 8, at: '2026-10-11T07:20:00Z' })],
    )
    expect(out.map(e => e.key)).toEqual(['log-2', 'asg-8', 'log-1', 'asg-7'])
  })
})

describe('summarize', () => {
  it('counts events, adds up panel time, and counts people but not the auto-assign robot', () => {
    const events = mergeHistory(
      [log({ id: '1', view_s: 480 }), log({ id: '2', actor: 'HungDT', view_s: 120 }), log({ id: '3', view_s: null, source: 'other' })],
      [asg({ id: 1, by: 'cron' }), asg({ id: 2, by: 'HungDT' })],
    )
    expect(summarize(events)).toEqual({ events: 5, seconds: 600, people: 2 })
  })
  it('is zero for an empty list', () => {
    expect(summarize([])).toEqual({ events: 0, seconds: 0, people: 0 })
  })
})

describe('groupByDay', () => {
  // 2026-10-11 is a Sunday in Vietnam as well as in UTC; use midday so the VN day is unambiguous.
  const now = new Date('2026-10-11T08:00:00Z')
  const ev = (key: string, at: string) => ({ ...fromAssign(asg({ id: Number(key), at })), key })

  it('labels today and yesterday, then plain dates, in Vietnam time', () => {
    const groups = groupByDay([
      ev('1', '2026-10-11T07:32:00Z'), ev('2', '2026-10-11T01:00:00Z'),
      ev('3', '2026-10-10T02:00:00Z'),
      ev('4', '2026-10-08T02:00:00Z'),
    ], now)
    expect(groups.map(g => g.label)).toEqual(['Today · Sun 11/10', 'Yesterday · Sat 10/10', 'Thu 08/10'])
    expect(groups.map(g => g.events.length)).toEqual([2, 1, 1])
  })
  it('splits days at midnight Vietnam time, not UTC', () => {
    // 17:30 UTC on the 10th is 00:30 on the 11th in Vietnam.
    const groups = groupByDay([ev('1', '2026-10-10T17:30:00Z'), ev('2', '2026-10-10T16:30:00Z')], now)
    expect(groups.map(g => g.label)).toEqual(['Today · Sun 11/10', 'Yesterday · Sat 10/10'])
  })
  it('adds the year for another year', () => {
    expect(groupByDay([ev('1', '2025-12-30T02:00:00Z')], now)[0].label).toBe('Tue 30/12/2025')
  })
  it('is empty for no events', () => {
    expect(groupByDay([], now)).toEqual([])
  })
})

describe('fmtClock', () => {
  it('shows HH:mm in Vietnam time', () => {
    expect(fmtClock('2026-10-11T07:32:00.000Z')).toBe('14:32')
  })
})
