/**
 * @jest-environment node
 *
 * The n8n workflow `workflows/drive-video-link-sync.json` is code inside JSON, so its Code nodes
 * are run here the way n8n runs them. What matters: a title that belongs to ONE game is linked
 * automatically, a title shared by DIFFERENT games is only suggested, and nothing is ever
 * written over an existing link.
 */
import fs from 'fs'
import path from 'path'

const wf = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'workflows/drive-video-link-sync.json'), 'utf8'))
const code = (name: string): string => wf.nodes.find((n: { name: string }) => n.name === name).parameters.jsCode

type Row = Record<string, unknown>
const items = (rows: Row[]) => ({ all: () => rows.map(json => ({ json })) })
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const run = (name: string, input: Row[], ctx: Record<string, Row> = {}) =>
  (new Function('$input', '$', code(name))(items(input), (node: string) => {
    if (!(node in ctx)) throw new Error(`no node ${node}`)
    return { first: () => ({ json: ctx[node] }) }
  }) as { json: Row }[])[0].json

const matched = (over: Row) => ({
  id: 1, game_id: 'g1', category_group: 'puzzle', drive_link: 'https://drive.google.com/file/d/A/view',
  file_name: 'A.mp4', shared_with: 0, ...over,
})

describe('drive-video-link-sync workflow', () => {
  it('is wired Trigger -> Config -> List -> Parse -> Match -> Build -> Update -> Summary -> Log', () => {
    const order = ['Google Drive Trigger', 'Config2', 'List Drive Files2', 'Parse File Names2', 'Match Titles in DB2',
      'Build Update SQL2', 'Update drive_link2', 'Summary2', 'Log flow_log2']
    for (let i = 0; i < order.length - 1; i++) {
      expect(wf.connections[order[i]].main[0][0].node).toBe(order[i + 1])
    }
  })

  describe('Parse File Names2 (the matching query)', () => {
    const files = [{ name: "Nail Box Sort.mp4", id: 'F1' }, { name: 'Nail Box Sort.mp4', id: 'F2' }, { name: 'Other.mov', id: 'F3' }]
    const out = run('Parse File Names2', files)

    it('keeps one file per title and counts them', () => {
      expect(out.totalFiles).toBe(2)
    })

    it('passes the file name along, with the link built from the file id', () => {
      expect(out.sql).toContain('"file_name":"Nail Box Sort.mp4"')
      expect(out.sql).toContain('https://drive.google.com/file/d/F1/view')
    })

    it('counts the OTHER games sharing the title by bundle_id, among games that have an evaluation', () => {
      expect(out.sql).toMatch(/count\(DISTINCT lower\(g\.bundle_id\)\)/)
      expect(out.sql).toMatch(/EXISTS \(SELECT 1 FROM game_evaluations e WHERE e\.game_id = g\.game_id\)/)
      expect(out.sql).toMatch(/GREATEST\(COALESCE\(s\.n, 1\) - 1, 0\) AS shared_with/)
    })

    it('only matches rows with no link (empty string counts as no link) and a known evaluator', () => {
      expect(out.sql).toMatch(/COALESCE\(ge\.drive_link, ''\) = ''/)
      expect(out.sql).not.toMatch(/drive_link IS NULL/)
      expect(out.sql).toMatch(/ge\.initial_evaluator IS NOT NULL/)
    })

    it('does nothing when there are no files', () => {
      expect(run('Parse File Names2', [])).toEqual({ sql: 'SELECT 1;', totalFiles: 0 })
    })
  })

  describe('Build Update SQL2', () => {
    it('does nothing when nothing matched', () => {
      expect(run('Build Update SQL2', [])).toEqual({ sql: 'SELECT 1;', count: 0, suggested: 0 })
    })

    it('links a one-game title directly and never touches the suggestion table', () => {
      const out = run('Build Update SQL2', [matched({ id: 11, shared_with: 0 })])
      expect(out).toMatchObject({ count: 1, suggested: 0 })
      expect(out.sql).toMatch(/UPDATE game_evaluations ge/)
      expect(out.sql).toContain('(11, \'https://drive.google.com/file/d/A/view\')')
      expect(out.sql).not.toMatch(/drive_link_suggestions/)
    })

    it('only suggests a title shared with another game: drive_link is not written', () => {
      const out = run('Build Update SQL2', [matched({ id: 22, shared_with: 2, file_name: 'Nail Box Sort.mp4' })])
      expect(out).toMatchObject({ count: 0, suggested: 1 })
      expect(out.sql).not.toMatch(/UPDATE game_evaluations/)
      expect(out.sql).toMatch(/INSERT INTO drive_link_suggestions/)
      expect(out.sql).toContain("(22, 'https://drive.google.com/file/d/A/view', 'Nail Box Sort.mp4', 2)")
    })

    it('splits a mixed batch into both, in one statement', () => {
      const out = run('Build Update SQL2', [matched({ id: 1, shared_with: 0 }), matched({ id: 2, shared_with: 1 })])
      expect(out).toMatchObject({ count: 1, suggested: 1 })
      expect(out.sql).toMatch(/^WITH upd AS/)
      expect(out.sql).toMatch(/sug AS/)
    })

    it('never overwrites an existing link, on either path', () => {
      const sql = run('Build Update SQL2', [matched({ id: 1, shared_with: 0 }), matched({ id: 2, shared_with: 1 })]).sql as string
      expect(sql.match(/COALESCE\(ge\.drive_link, ''\) = ''/g)).toHaveLength(2)
    })

    it('does not rewrite a suggestion that has not changed', () => {
      const sql = run('Build Update SQL2', [matched({ id: 2, shared_with: 1 })]).sql as string
      expect(sql).toMatch(/WHERE drive_link_suggestions\.link IS DISTINCT FROM EXCLUDED\.link/)
    })

    it('escapes quotes in file names and links', () => {
      const out = run('Build Update SQL2', [matched({ id: 3, shared_with: 1, file_name: "It's a game.mp4", drive_link: "https://x/it's" })])
      expect(out.sql).toContain("'It''s a game.mp4'")
      expect(out.sql).toContain("'https://x/it''s'")
    })

    it('ignores rows without an id or a link', () => {
      expect(run('Build Update SQL2', [matched({ id: null }), matched({ drive_link: '' })])).toMatchObject({ count: 0, suggested: 0 })
    })
  })

  describe('Summary2', () => {
    it('logs the rows the statement actually changed, not the rows it proposed', () => {
      const out = run('Summary2', [], {
        'Update drive_link2': { auto_synced: '4', suggested: '2' },
        'Parse File Names2': { totalFiles: 9 },
      })
      expect(out).toMatchObject({ name: 'drive-video-link-sync', status: 'success' })
      expect(JSON.parse(out.note as string)).toEqual({ total_files: 9, matched_updated: 4, suggested: 2 })
    })

    it('still logs when the statement returned nothing (a run with no matches)', () => {
      const out = run('Summary2', [], { 'Update drive_link2': {}, 'Parse File Names2': { totalFiles: 3 } })
      expect(JSON.parse(out.note as string)).toEqual({ total_files: 3, matched_updated: 0, suggested: 0 })
    })
  })
})
