import { unsavedFields, type FormValues, type LoadedRow } from '@/lib/unsaved-fields'

const parts = { gameplay: '', game_over: '', level_complete: '', self_note: '' }
const row: LoadedRow = {
  noteParts: { ...parts, self_note: 'old note that is long enough' },
  initial_conclusion: 'Bypass', batch: null, drive_link: null, game_alike: [],
  final_note: null, final_conclusion: null,
  record_5min_drive: null, record_20min_drive: null, record_5min_assignee: null, record_20min_assignee: null,
}
const same: FormValues = {
  noteParts: row.noteParts, conclusion: 'Bypass', batch: '', driveLink: '', gameAlike: [],
  finalNote: '', finalConclusion: '', drive5: '', drive20: '', rec5Assignee: '', rec20Assignee: '',
}
const none = { trendsTouched: false, stagedShots: 0 }

describe('unsavedFields', () => {
  it('is empty when the form matches the loaded row, treating null and "" as the same', () => {
    expect(unsavedFields(same, row, none)).toEqual([])
  })
  it('names each edited field in a stable order', () => {
    const form: FormValues = {
      ...same, conclusion: 'List_Idea', batch: 'W2 Oct, 2026', driveLink: 'https://drive.google.com/x',
      noteParts: { ...row.noteParts, self_note: 'new note', gameplay: 'g' },
      finalConclusion: 'Priority IV', finalNote: 'n',
    }
    expect(unsavedFields(form, row, none)).toEqual([
      'Initial conclusion', 'Self note', 'Gameplay', 'Batch', 'Demo video link', 'Final conclusion', 'Final note',
    ])
  })
  it('ignores a batch edit unless the conclusion is List_Idea, since only then does it get saved', () => {
    expect(unsavedFields({ ...same, batch: 'W2 Oct, 2026' }, row, none)).toEqual([])
    expect(unsavedFields({ ...same, conclusion: 'List_Idea', batch: 'W2 Oct, 2026' }, { ...row, initial_conclusion: 'List_Idea' }, none))
      .toEqual(['Batch'])
  })
  it('compares game alike by content, not identity', () => {
    const alike = [{ game_id: 'g1', title: 'Merge Whale' }]
    expect(unsavedFields({ ...same, gameAlike: [...alike] }, { ...row, game_alike: alike }, none)).toEqual([])
    expect(unsavedFields({ ...same, gameAlike: alike }, row, none)).toEqual(['Game alike'])
    expect(unsavedFields(same, { ...row, game_alike: null }, none)).toEqual([])
  })
  it('adds trend tags and staged screenshots from the extras', () => {
    expect(unsavedFields(same, row, { trendsTouched: true, stagedShots: 1 })).toEqual(['Trend tags', 'Screenshot'])
    expect(unsavedFields(same, row, { trendsTouched: false, stagedShots: 3 })).toEqual(['Screenshots (3)'])
  })
  it('names recording fields', () => {
    expect(unsavedFields({ ...same, drive5: 'x', rec20Assignee: 'Bob' }, row, none))
      .toEqual(['Recording 5-min link', 'Recording 20-min assignee'])
  })
})
