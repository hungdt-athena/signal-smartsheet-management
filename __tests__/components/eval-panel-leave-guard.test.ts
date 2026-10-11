import { readFileSync } from 'fs'
import path from 'path'

const read = (p: string) => readFileSync(path.join(__dirname, '../..', p), 'utf8')
const panel = read('components/EvalDetailPanel.tsx')

// The panel is too large to render in a unit test; like eval-panel-timing.test.ts, these pin
// the wiring in the source. The decision itself is tested in leave-decision.test.ts.
describe('EvalDetailPanel unsaved-changes guard', () => {
  it('sends every way off the game through requestLeaveRef', () => {
    expect(panel).toMatch(/requestLeaveRef\.current\('prev', \(\) => goTo\(gameList\[idx\]\.game_id\)\)/)
    expect(panel).toMatch(/requestLeaveRef\.current\('next', \(\) => goTo\(gameList\[idx\]\.game_id\)\)/)
    expect(panel).toMatch(/onChange=\{v => requestLeaveRef\.current\('jump', \(\) => goTo\(v\)\)\}/)
    expect(panel).toMatch(/onClick=\{\(\) => requestLeaveRef\.current\('close', onClose\)\}/)
    expect(panel).toMatch(/requestLeaveRef\.current\('close', \(\) => onClose\?\.\(\)\)/)
  })
  it('no navigation or close path skips the guard', () => {
    // goTo may only be called from inside a guarded callback; onClose only through the guard.
    // (It is defined as `const goTo = useCallback(`, so the pattern below sees calls only.)
    const calls = panel.match(/\bgoTo\(/g) ?? []
    const guarded = panel.match(/requestLeaveRef\.current\('(?:prev|next|jump)', \(\) => goTo\(/g) ?? []
    expect(calls.length).toBe(guarded.length)
    expect(guarded.length).toBe(3) // prev, next, jump
    expect(panel).not.toMatch(/onClick=\{onClose\}/)
  })
  it('a popup open blocks the arrow keys, and Esc closes only the popup', () => {
    const onKey = panel.slice(panel.indexOf('const onKey = '), panel.indexOf("window.addEventListener('keydown', onKey)"))
    expect(onKey.indexOf('if (leave)')).toBeGreaterThan(-1)
    expect(onKey.indexOf('if (leave)')).toBeLessThan(onKey.indexOf("'ArrowLeft'"))
    expect(onKey).toMatch(/if \(leave\) \{ if \(e\.key === 'Escape' && !leaveSaving\) setLeave\(null\); return \}/)
  })
  it('Save only lets the user move on when the save worked', () => {
    expect(panel).toMatch(/const save = async \(\): Promise<boolean> =>/)
    expect(panel).toMatch(/const ok = await saveRef\.current\(\)[\s\S]{0,240}if \(ok\) pending\.proceed\(\)/)
    // a failed screenshot upload counts as not saved, so staged shots are not silently dropped
    expect(panel).toMatch(/saved = shotsOk/)
  })
  it('with auto-save on, saves first and moves only if that worked', () => {
    expect(panel).toMatch(/decision === 'save-then-go'\) \{ void saveRef\.current\(\)\.then\(ok => \{ if \(ok\) proceed\(\) \}\)/)
  })
  it('registers the same ask with the global guard so a click outside goes through it', () => {
    expect(panel).toMatch(/requestLeave: proceed => requestLeaveRef\.current\('close', proceed\)/)
    for (const page of ['app/(manager)/evaluations/page.tsx', 'app/(manager)/youtube/page.tsx']) {
      const src = read(page)
      expect(src).toMatch(/import \{ requestLeaveUnsaved \} from '@\/lib\/unsaved-guard'/)
      expect(src).not.toMatch(/<div className="eval-modal-backdrop" onClick=\{\(\) => setDetailGameId\(null\)\}>/)
    }
    expect(read('app/(manager)/evaluations/page.tsx')).toMatch(/onClick=\{\(\) => requestLeaveUnsaved\(handleClose\)\}/)
  })
  it('shows the popup with Save blocked while the note is too short', () => {
    expect(panel).toMatch(/saveBlockedReason=\{noteTooShort \? noteError : null\}/)
  })
})
