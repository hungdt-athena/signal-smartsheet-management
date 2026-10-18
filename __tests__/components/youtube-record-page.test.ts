import fs from 'node:fs'
import path from 'node:path'

// The YouTube / Record page reads its colours and frames from the shared kit, so
// the same status or conclusion looks the same here as in the eval panel and
// Short List. These checks keep local copies from creeping back.
const src = fs.readFileSync(path.join(process.cwd(), 'app/(manager)/youtube/page.tsx'), 'utf8')

describe('YouTube / Record page', () => {
  it('takes record status colours from lib/conclusion-badge, and shows no conclusion badges', () => {
    expect(src).toMatch(/RECORD_STATUS_BADGE\[status\]/)
    expect(src).not.toMatch(/FINAL_CONC_STYLES|RECORD_STATUS_STYLES/)
    // Every game in a container is List_Idea + Insight/Priority IV, so the badges said nothing.
    expect(src).not.toMatch(/finalConclusionStyle\(item\.final_conclusion\)/)
    expect(src).toMatch(/<GameIcon src=\{item\.icon_url\} os=\{item\.os\}/)
  })

  it('opens every page modal through <Modal>, with no letter "x" close buttons', () => {
    expect(src).not.toMatch(/>x<\/button>/)
    expect(src).not.toMatch(/useEscapeToClose/)
    expect((src.match(/<Modal\b/g) || []).length).toBeGreaterThanOrEqual(4)
  })

  it('stacks Confirm add next to the Add game modal, so its Cancel closes only itself', () => {
    expect(src).toMatch(/<\/Modal>\s*\{\/\*[^*]*\*\/\}\s*\{pending && \(\s*<ConfirmAddModal/)
    expect(src).toMatch(/onCancel=\{\(\) => setPending\(null\)\}/)
  })

  it('keeps Record filters in the URL and still scopes non-managers to their own rows', () => {
    for (const key of ['cat', 'batch', 'status']) expect(src).toContain(`useUrlState('${key}'`)
    // Grouping by recorder is always on now: no toggle, no URL key.
    expect(src).not.toContain("useUrlState('group'")
    expect(src).toMatch(/if \(!isManager && userName\) params\.set\('recorder', userName\)/)
  })

  it('keeps YouTube filters in the URL', () => {
    for (const key of ['year', 'month', 'ev', 'dur']) expect(src).toContain(`useUrlState('${key}'`)
  })

  it('reports the YouTube recorder sync with a toast, not a page-local banner', () => {
    expect(src).not.toMatch(/syncToast/)
    expect(src).toMatch(/toast\.success\(`Updated \$\{parts\.join/)
  })
})
