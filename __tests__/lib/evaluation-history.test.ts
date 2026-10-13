import {
  fromLog, fromAssign, mergeHistory, fmtDuration, summarize, groupByDay, fmtClock,
  type LogRow, type AssignRow,
} from '@/lib/evaluation-history'

const log = (o: Partial<LogRow>): LogRow => ({
  id: '1', at: '2026-10-11T07:32:00.000Z', actor: 'Alice', owner: 'Alice', source: 'panel', context: 'evaluate',
  kind: 'first', conclusion_before: null, conclusion_after: 'Bypass', final_before: null, final_after: null,
  batch_before: null, batch_after: null, demo_added: false, bucket_before: null, bucket_after: null, recorder_before: null, recorder_after: null, owner_after: null,
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
  it('a save that only added the demo link is "added the demo link", with no verdict chip', () => {
    const e = fromLog(log({ kind: 'revise', source: 'other', context: null, changed: false, conclusion_before: 'Bypass', conclusion_after: 'Bypass', demo_added: true }))
    expect(e.verb).toBe('added the demo link')
    expect(e.changes).toEqual([])
  })
  it('keeps the verdict change when the verdict moved in the same save as the link', () => {
    const e = fromLog(log({ kind: 'revise', changed: true, conclusion_before: 'Bypass', conclusion_after: 'List_Idea', demo_added: true }))
    expect(e.verb).toBe('changed the verdict')
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
  it('an add-to-record pull is its own type, never timed, with the bucket in the verb and the batch in the note', () => {
    const e = fromLog(log({ kind: 'record_add', source: 'add_to_record', view_s: null, context: null, owner: 'Alice', owner_after: 'Shortcut',
      conclusion_before: 'Bypass', conclusion_after: 'List_Idea', final_before: null, final_after: 'Insight',
      bucket_after: '5min', batch_before: 'W2 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e).toMatchObject({ who: 'Alice', type: 'record', verb: 'added to Record · 5 min', time: null, seconds: null, note: 'Batch W2 Oct, 2026' })
    expect(e.changes).toEqual([
      { kind: 'person', label: 'Evaluator', from: 'Alice', to: 'Shortcut' },
      { kind: 'initial', from: 'Bypass', to: 'List_Idea' },
      { kind: 'final', from: null, to: 'Insight' },
    ])
  })
  it('an add-to-record pull lists only what moved, and says when the batch moved too', () => {
    const e = fromLog(log({ kind: 'record_add', source: 'add_to_record', view_s: null, owner: 'Shortcut', owner_after: 'Shortcut',
      conclusion_before: 'List_Idea', conclusion_after: 'List_Idea', final_before: 'Priority IV', final_after: 'Priority IV',
      bucket_after: '20min', batch_before: 'W1 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e.verb).toBe('added to Record · 20 min')
    expect(e.changes).toEqual([])
    expect(e.note).toBe('Batch W2 Oct, 2026 · was W1 Oct, 2026')
    // an unfilled owner_after (old row) shows no person line
    expect(fromLog(log({ kind: 'record_add', source: 'add_to_record', view_s: null, owner: 'Alice', owner_after: null, bucket_after: '5min' })).changes.map(c => c.kind)).toEqual(['initial'])
  })
  it('an add-to-record row from before the Record kinds existed still reads as an add', () => {
    const e = fromLog(log({ source: 'add_to_record', view_s: null, context: null, conclusion_before: 'Bypass', conclusion_after: 'List_Idea' }))
    expect(e).toMatchObject({ type: 'record', verb: 'added to Record', time: null, seconds: null, note: null })
    expect(e.changes).toEqual([{ kind: 'initial', from: 'Bypass', to: 'List_Idea' }])
  })
  it('the first confirmed recorder is "assigned", with the batch as the note and no change lines', () => {
    const e = fromLog(log({ kind: 'record_assign', source: 'record_tab', view_s: null, context: null, actor: 'VinhTD', bucket_after: '20min',
      recorder_after: 'MyTL', batch_before: 'W2 Oct, 2026', batch_after: 'W2 Oct, 2026', conclusion_before: 'List_Idea', conclusion_after: 'List_Idea' }))
    expect(e).toMatchObject({ who: 'VinhTD', type: 'record', verb: 'assigned MyTL to Record · 20 min', changes: [], note: 'Batch W2 Oct, 2026', time: null, seconds: null })
  })
  it('a later confirm with someone else is "reassigned ... from A to B"', () => {
    const e = fromLog(log({ kind: 'record_assign', source: 'record_tab', view_s: null, actor: 'VinhTD', bucket_after: '20min',
      recorder_before: 'MyTL', recorder_after: 'Bob', batch_before: 'W2 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e.verb).toBe('reassigned Record · 20 min from MyTL to Bob')
    expect(e.changes).toEqual([])
  })
  it('an assign without a batch has no note', () => {
    expect(fromLog(log({ kind: 'record_assign', source: 'record_tab', view_s: null, bucket_after: '5min', recorder_after: 'Bob' })).note).toBeNull()
  })
  it('a Record row from the save route (panel / other) keeps its Record wording and is not timed', () => {
    const e = fromLog(log({ kind: 'record_assign', source: 'panel', context: 'record', view_s: 90, bucket_after: '5min', recorder_after: 'Bob', batch_after: 'W2' }))
    expect(e).toMatchObject({ type: 'record', verb: 'assigned Bob to Record · 5 min', time: null, seconds: null, note: 'Batch W2' })
  })
  it('a move shows the buckets in the verb, and the recorder and batch in the note', () => {
    const e = fromLog(log({ kind: 'record_move', source: 'record_tab', view_s: null, actor: 'VinhTD', bucket_before: '5min', bucket_after: '20min',
      recorder_before: 'MyTL', recorder_after: 'MyTL', batch_before: 'W2 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e).toMatchObject({ type: 'record', verb: 'moved the game in Record · 5 min → 20 min', changes: [], note: 'Recorder MyTL · Batch W2 Oct, 2026' })
    // no recorder: only the batch
    expect(fromLog(log({ kind: 'record_move', source: 'record_tab', bucket_before: '20min', bucket_after: '5min', batch_after: 'W2' })).note).toBe('Batch W2')
  })
  it('a remove says which bucket it was in and who was recording', () => {
    const e = fromLog(log({ kind: 'record_remove', source: 'record_tab', view_s: null, actor: 'VinhTD', bucket_before: '20min', recorder_before: 'MyTL', batch_before: 'W2 Oct, 2026', batch_after: 'W2 Oct, 2026' }))
    expect(e).toMatchObject({ type: 'record', verb: 'removed the game from Record · was 20 min', changes: [], note: 'Recorder was MyTL · Batch W2 Oct, 2026' })
    expect(fromLog(log({ kind: 'record_remove', source: 'record_tab', bucket_before: '5min' })).note).toBeNull()
  })
  it('Record events never get the generic batch change line, even when the batch moved', () => {
    for (const kind of ['record_assign', 'record_move', 'record_remove']) {
      const e = fromLog(log({ kind, source: 'record_tab', bucket_before: '5min', bucket_after: '20min', batch_before: 'W1', batch_after: 'W2' }))
      expect(e.changes.map(c => c.kind)).not.toContain('batch')
    }
  })
  it('a Record row with missing or unknown fields still reads sensibly', () => {
    expect(fromLog(log({ kind: 'record_assign', source: 'record_tab', recorder_after: null, bucket_after: null }))).toMatchObject({ verb: 'assigned a recorder to Record' })
    expect(fromLog(log({ kind: 'record_assign', source: 'record_tab', recorder_before: 'A', recorder_after: null, bucket_after: 'weird' })).verb).toBe('reassigned Record from A to —')
    expect(fromLog(log({ kind: 'record_move', source: 'record_tab', bucket_before: null, bucket_after: '20min' })).verb).toBe('moved the game in Record · to 20 min')
    expect(fromLog(log({ kind: 'record_move', source: 'record_tab', bucket_before: null, bucket_after: null })).verb).toBe('moved the game in Record')
    expect(fromLog(log({ kind: 'record_remove', source: 'record_tab', bucket_before: null })).verb).toBe('removed the game from Record')
    expect(fromLog(log({ kind: 'record_add', source: 'add_to_record', bucket_after: null, owner_after: null, conclusion_before: null, conclusion_after: null })))
      .toMatchObject({ verb: 'added to Record', changes: [] })
    // fields absent altogether (an API that predates the new columns)
    const bare = { id: '9', at: '2026-10-11T07:32:00Z', actor: 'VinhTD', owner: null, source: 'record_tab', context: null, kind: 'record_move',
      conclusion_before: null, conclusion_after: null, final_before: null, final_after: null, batch_before: null, batch_after: null,
      changed: false, view_s: null, confidence: null } as unknown as LogRow
    expect(fromLog(bare)).toMatchObject({ type: 'record', verb: 'moved the game in Record', note: null })
  })
  it('a seeded Record assignment is credited to nobody and says it was copied', () => {
    const e = fromLog(log({ kind: 'record_assign', source: 'seed', actor: null, owner: 'Carol', view_s: null, context: null, confidence: 'ok', bucket_after: '20min', recorder_after: 'MyTL', batch_before: 'W2', batch_after: 'W2' }))
    expect(e).toMatchObject({ who: '—', type: 'record', verb: 'assigned MyTL to Record · 20 min', changes: [], note: 'Copied from the old record', time: null })
  })
  it('a final conclusion that puts a game in Record says so in the note', () => {
    const base = { kind: 'final', changed: false, conclusion_before: 'List_Idea', conclusion_after: 'List_Idea' }
    expect(fromLog(log({ ...base, final_before: null, final_after: 'Priority IV', context: 'shortlist' })).note).toBe('From Short List · Enters Record · 20 min')
    expect(fromLog(log({ ...base, final_before: null, final_after: 'Priority IV' })).note).toBe('Enters Record · 20 min')
    expect(fromLog(log({ ...base, final_before: null, final_after: 'Insight' })).note).toBe('Enters Record · 5 min')
    // it moved to the other bucket
    expect(fromLog(log({ ...base, final_before: 'Insight', final_after: 'Priority IV' })).note).toBe('Enters Record · 20 min')
    // a verdict save that also moved the final counts too
    expect(fromLog(log({ kind: 'revise', conclusion_before: 'Bypass', conclusion_after: 'List_Idea', final_before: null, final_after: 'Insight' })).note).toBe('Enters Record · 5 min')
  })
  it('a final conclusion does not say "Enters Record" when the game was already in that bucket or the final has no bucket', () => {
    expect(fromLog(log({ kind: 'final', changed: false, final_before: 'Priority IV', final_after: 'Priority IV' })).note).toBeNull() // unchanged
    expect(fromLog(log({ kind: 'final', changed: false, final_before: 'Priority II', final_after: 'Priority I' })).note).toBeNull()
    expect(fromLog(log({ kind: 'final', changed: false, final_before: 'Priority IV', final_after: 'Priority II' })).note).toBeNull() // leaving Record
    expect(fromLog(log({ kind: 'final', changed: false, final_before: 'Priority IV', final_after: null })).note).toBeNull()
    expect(fromLog(log({ kind: 'first', final_before: 'Insight', final_after: 'Insight' })).note).toBeNull()
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

describe('Record events in the summary and the day list', () => {
  it('count as events, and the actor counts as a person', () => {
    const events = mergeHistory([
      log({ id: '1', kind: 'record_move', source: 'record_tab', actor: 'VinhTD', view_s: null, bucket_before: '5min', bucket_after: '20min' }),
      log({ id: '2', kind: 'record_assign', source: 'seed', actor: null, view_s: null, bucket_after: '5min', recorder_after: 'Bob' }),
    ], [])
    expect(summarize(events)).toEqual({ events: 2, seconds: 0, people: 1 })
    expect(groupByDay(events, new Date('2026-10-11T08:00:00Z'))[0].events).toHaveLength(2)
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
