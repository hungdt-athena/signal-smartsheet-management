import {
  EMPTY_NOTE_PARTS, NOTE_MIN_LEN, composeInitialNote, isLegacyNote, missingNoteParts, notePartsFromRow,
  notePartsRequirementError, noteRequirementError, parseNoteParts,
} from '@/lib/eval-rules'

const ok = 'Solid core loop, weak meta'
const short = 'meh'

describe('noteRequirementError', () => {
  it('requires a long enough note on every save', () => {
    expect(noteRequirementError({ note: short, conclusion: 'List_Idea' }))
      .toContain(String(NOTE_MIN_LEN))
    expect(noteRequirementError({ note: '', conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: null, conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: ok, conclusion: 'List_Idea' })).toBeNull()
  })

  it('blocks a reopened game whose stored note is too short', () => {
    // legacy short note, resent untouched — now blocks
    expect(noteRequirementError({ note: short, conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: '', conclusion: null })).not.toBeNull()
  })

  it('counts trimmed length, not padding', () => {
    expect(noteRequirementError({ note: '         ', conclusion: 'List_Idea' })).not.toBeNull()
    expect(noteRequirementError({ note: `  ${ok}  `, conclusion: 'List_Idea' })).toBeNull()
  })

  it('exempts Link_dead', () => {
    expect(noteRequirementError({ note: '', conclusion: 'Link_dead' })).toBeNull()
  })
})

describe('four-part initial note', () => {
  const P = (p: Partial<typeof EMPTY_NOTE_PARTS>) => ({ ...EMPTY_NOTE_PARTS, ...p })
  const full = P({ gameplay: 'Tap to shoot bubbles', game_over: 'the board fills up', level_complete: 'all bubbles popped' })

  it('joins filled parts as prefixed lines, Self Note first, skipping empty ones', () => {
    expect(composeInitialNote(P({ gameplay: ' Tap to shoot ', level_complete: 'all bubbles popped', self_note: 'fun' })))
      .toBe('Note: fun\nGameplay: Tap to shoot\nLevel complete: all bubbles popped')
    expect(composeInitialNote(EMPTY_NOTE_PARTS)).toBeNull()
  })

  it('stores a Self Note on its own unprefixed', () => {
    expect(composeInitialNote(P({ self_note: 'nothing special' }))).toBe('nothing special')
  })

  it('loads a pre-split note into Self Note', () => {
    expect(notePartsFromRow({ initial_note: 'old note' })).toEqual(P({ self_note: 'old note' }))
    expect(notePartsFromRow({ initial_note: 'Gameplay: x', initial_gameplay: 'x' })).toEqual(P({ gameplay: 'x' }))
  })

  it('treats only a stored List_Idea note without Gameplay as legacy', () => {
    expect(isLegacyNote({ initial_note: 'old note', initial_gameplay: null, initial_conclusion: 'List_Idea' })).toBe(true)
    expect(isLegacyNote({ initial_note: 'old note', initial_gameplay: null, initial_conclusion: 'Bypass' })).toBe(false)
    expect(isLegacyNote({ initial_note: null, initial_gameplay: null, initial_conclusion: 'List_Idea' })).toBe(false)
    expect(isLegacyNote({ initial_note: 'Gameplay: tap', initial_gameplay: 'tap', initial_conclusion: 'List_Idea' })).toBe(false)
  })

  it('List_Idea needs the three gameplay parts, Self Note optional', () => {
    const r = (parts: typeof full) => missingNoteParts({ parts, conclusion: 'List_Idea', legacy: false })
    expect(r(full)).toEqual([])
    expect(r(P({ self_note: 'a long enough self note' }))).toEqual(['gameplay', 'game_over', 'level_complete'])
    expect(r({ ...full, gameplay: 'short' })).toEqual(['gameplay'])
    expect(r({ ...full, level_complete: '  ' })).toEqual(['level_complete'])
    expect(notePartsRequirementError({ parts: P({}), conclusion: 'List_Idea', legacy: false }))
      .toMatch(/Gameplay, The game is over when, The level is complete when/)
  })

  it('any other conclusion needs a Self Note only', () => {
    expect(missingNoteParts({ parts: full, conclusion: 'Bypass', legacy: false })).toEqual(['self_note'])
    expect(missingNoteParts({ parts: P({ self_note: 'nothing special' }), conclusion: 'Bypass', legacy: false })).toEqual([])
    expect(missingNoteParts({ parts: P({ self_note: 'meh' }), conclusion: null, legacy: false })).toEqual(['self_note'])
  })

  it('a legacy List_Idea note keeps the whole-note rule', () => {
    expect(missingNoteParts({ parts: P({ self_note: 'a long enough old note' }), conclusion: 'List_Idea', legacy: true })).toEqual([])
    expect(missingNoteParts({ parts: P({ self_note: 'meh' }), conclusion: 'List_Idea', legacy: true })).toEqual(['self_note'])
  })

  it('exempts Link_dead', () => {
    expect(notePartsRequirementError({ parts: EMPTY_NOTE_PARTS, conclusion: 'Link_dead', legacy: false })).toBeNull()
  })

  it('coerces a request body value', () => {
    expect(parseNoteParts(null)).toBeNull()
    expect(parseNoteParts('text')).toBeNull()
    expect(parseNoteParts({ gameplay: 'x', game_over: 3 })).toEqual(P({ gameplay: 'x' }))
  })
})
