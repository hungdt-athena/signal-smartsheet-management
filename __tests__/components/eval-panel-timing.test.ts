import fs from 'node:fs'
import path from 'node:path'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')

describe('Eval panel timing wiring', () => {
  const src = read('components/EvalDetailPanel.tsx')
  const save = src.slice(src.indexOf('const save = async () => {'), src.indexOf('// Auto-save:'))

  it('snapshots the timer before the first await in save()', () => {
    const snap = save.indexOf('snapshot(viewRef.current')
    expect(snap).toBeGreaterThan(-1)
    expect(snap).toBeLessThan(save.indexOf('await '))
  })

  it('sends the timing fields with the PATCH', () => {
    expect(save).toMatch(/view_s: snap\.view_s/)
    expect(save).toMatch(/context: logContext/)
  })

  it('restarts the timer only on a successful save', () => {
    expect(save.indexOf('restartAfterSave(')).toBeGreaterThan(save.indexOf('if (!res.ok)'))
  })

  it('does not paint a refetched game the user has left', () => {
    expect(save).toMatch(/currentGameIdRef\.current === ev\.game_id/)
    expect(save).toMatch(/shownGameRef\.current === ev\.game_id/)
    expect(src).toMatch(/shownGameRef\.current = data\.game_id/)
  })

  it('starts the timer on every game change', () => {
    expect(src).toMatch(/viewRef\.current = startView\(currentGameId/)
  })

  it.each([
    ['app/(manager)/evaluations/page.tsx', ['shortlist', 'evaluate']],
    ['app/(manager)/evaluations/[gameId]/page.tsx', ['evaluate']],
    ['app/(manager)/youtube/page.tsx', ['record']],
    ['components/TaggingTab.tsx', ['tagging']],
  ])('%s passes the right logContext to each panel', (file, expected) => {
    const mounts = read(file).split('<EvalDetailPanel').slice(1).map(s => s.slice(0, s.indexOf('/>')))
    expect(mounts.map(m => (m.match(/logContext="(\w+)"/) || [])[1])).toEqual(expected)
  })
})
