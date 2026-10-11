import { fromLog, fromAssign, mergeHistory, fmtDuration, type LogRow, type AssignRow } from '@/lib/evaluation-history'

const log = (o: Partial<LogRow>): LogRow => ({
  id: '1', at: '2026-10-11T07:32:00.000Z', actor: 'Alice', owner: 'Alice', source: 'panel', context: 'evaluate',
  kind: 'first', conclusion_before: null, conclusion_after: 'Bypass', final_before: null, final_after: null,
  changed: true, view_s: 480, confidence: null, ...o,
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
  it('a first save shows the verdict change and the panel time', () => {
    expect(fromLog(log({}))).toEqual({
      key: 'log-1', at: '2026-10-11T07:32:00.000Z', who: 'Alice', action: 'Save',
      detail: '— → Bypass', time: '8m', note: null,
    })
  })
  it('a save that keeps the verdict says Edited and names the verdict', () => {
    const e = fromLog(log({ kind: 'revise', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass' }))
    expect(e.detail).toBe('Edited · Bypass')
  })
  it('adds the final conclusion change when it moved', () => {
    const e = fromLog(log({ kind: 'revise', changed: true, conclusion_before: 'Bypass', conclusion_after: 'List_Idea',
      final_before: null, final_after: 'Priority I' }))
    expect(e.detail).toBe('Bypass → List Idea · Final: — → Priority I')
  })
  it('a final-only save is labelled Final and shows only the final change', () => {
    const e = fromLog(log({ kind: 'final', changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass',
      final_before: 'Priority II', final_after: 'Priority I' }))
    expect(e.action).toBe('Final')
    expect(e.detail).toBe('Priority II → Priority I')
  })
  it('a clear is labelled Clear', () => {
    const e = fromLog(log({ kind: 'clear', conclusion_before: 'Bypass', conclusion_after: null }))
    expect(e.action).toBe('Clear')
    expect(e.detail).toBe('Bypass → —')
  })
  it('writes List_Idea the way the rest of the app does', () => {
    expect(fromLog(log({ changed: false, conclusion_after: 'List_Idea' })).detail).toBe('Edited · List Idea')
  })
  it('a save that changed neither verdict nor final says Edited', () => {
    const e = fromLog(log({ kind: 'other', changed: false, conclusion_before: null, conclusion_after: null }))
    expect(e.detail).toBe('Edited')
  })
  it('names the tab when the save came from another panel than Evaluate', () => {
    expect(fromLog(log({ context: 'shortlist' })).note).toBe('From Short List')
    expect(fromLog(log({ context: 'record' })).note).toBe('From Record')
    expect(fromLog(log({ context: 'tagging' })).note).toBe('From Tagging')
  })
  it('a save without panel timing has no time', () => {
    expect(fromLog(log({ source: 'other', view_s: null, context: null })).time).toBeNull()
  })
  it('an add-to-record pull is labelled and never timed', () => {
    const e = fromLog(log({ source: 'add_to_record', view_s: null, context: null, conclusion_after: 'List_Idea', conclusion_before: 'Bypass' }))
    expect(e.action).toBe('Add to record')
    expect(e.time).toBeNull()
  })
  it('a seed row is an old verdict credited to the owner, with a warning when its time is unsure', () => {
    const ok = fromLog(log({ source: 'seed', actor: null, owner: 'Carol', view_s: null, context: null, confidence: 'ok' }))
    expect(ok).toMatchObject({ who: 'Carol', action: 'Old verdict', detail: 'Bypass', time: null,
      note: 'Copied from the old record' })
    const low = fromLog(log({ source: 'seed', actor: null, owner: 'Carol', view_s: null, context: null, confidence: 'low' }))
    expect(low.note).toBe('Copied from the old record · time may be off')
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
      key: 'asg-7', at: '2026-10-10T02:00:00.000Z', who: 'Auto-assign', action: 'Reassign',
      detail: 'Bob → Alice', time: null, note: null,
    })
  })
  it('an assign has no source person', () => {
    const e = fromAssign(asg({ action: 'assign', from_evaluator: null, by: 'HungDT' }))
    expect(e).toMatchObject({ who: 'HungDT', action: 'Assign', detail: '→ Alice' })
  })
  it('capitalises any action, including rescue and handover', () => {
    expect(fromAssign(asg({ action: 'rescue' })).action).toBe('Rescue')
    expect(fromAssign(asg({ action: 'handover' })).action).toBe('Handover')
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
