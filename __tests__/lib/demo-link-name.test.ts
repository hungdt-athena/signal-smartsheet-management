import { driveFileId, matchDemoFileName, looksLikeUrl } from '@/lib/demo-link-name'

const ID = '1RkrD1SUgo_g2vCD3rxOAJw5LB5fBIaTx'

describe('driveFileId', () => {
  it.each([
    [`https://drive.google.com/file/d/${ID}/view`],
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`],
    [`https://drive.google.com/file/d/${ID}`],
    [`https://docs.google.com/file/d/${ID}/edit`],
    [`https://drive.google.com/open?id=${ID}`],
    [`https://drive.google.com/uc?id=${ID}&export=download`],
    [`https://drive.google.com/uc?export=download&id=${ID}`],
    [`https://docs.google.com/uc?export=view&id=${ID}`],
    [`  https://drive.google.com/file/d/${ID}/view  `],
  ])('reads the id from %s', link => {
    expect(driveFileId(link)).toBe(ID)
  })

  it.each([
    [''],
    ['not a link'],
    ['https://www.youtube.com/watch?v=abc123'],
    [`https://example.com/file/d/${ID}/view`],
    [`https://evil.com/?id=${ID}`],
    ['https://drive.google.com/drive/folders/'],
    ['https://drive.google.com/open?foo=bar'],
    ['https://drive.google.com/file/d//view'],
  ])('null for %s', link => {
    expect(driveFileId(link)).toBeNull()
  })
})

describe('looksLikeUrl', () => {
  it('accepts http(s) links only', () => {
    expect(looksLikeUrl('https://drive.google.com/x')).toBe(true)
    expect(looksLikeUrl(' http://a.b ')).toBe(true)
    expect(looksLikeUrl('https://')).toBe(false)
    expect(looksLikeUrl('drive.google')).toBe(false)
    expect(looksLikeUrl('')).toBe(false)
  })
})

describe('matchDemoFileName', () => {
  it('ok for the exact title', () => {
    expect(matchDemoFileName('Ocean Crown', { code: null, title: 'Ocean Crown' })).toBe('ok')
  })

  it('ok for a different case and an extension', () => {
    expect(matchDemoFileName('Ocean Crown.mp4', { code: null, title: 'Ocean Crown' })).toBe('ok')
    expect(matchDemoFileName('ocean   CROWN.MOV', { code: 'QD6SF3', title: 'Ocean Crown' })).toBe('ok')
  })

  it('ok when the subtitle is dropped', () => {
    expect(matchDemoFileName('Find The Suspect.mp4', { code: null, title: 'Find The Suspect - Clue Puzzle' })).toBe('ok')
    expect(matchDemoFileName('Picky Picnic.mp4', { code: null, title: 'Picky Picnic: Cozy Farm' })).toBe('ok')
    expect(matchDemoFileName('Find The Suspect.mp4', { code: null, title: 'Find The Suspect – Clue Puzzle' })).toBe('ok')
  })

  it('ok with the full title including its subtitle', () => {
    expect(matchDemoFileName('Picky Picnic: Cozy Farm.mp4', { code: null, title: 'Picky Picnic: Cozy Farm' })).toBe('ok')
  })

  it('unifies curly quotes', () => {
    expect(matchDemoFileName('Mom’s Diary.mp4', { code: null, title: "Mom's Diary" })).toBe('ok')
  })

  it('ok for the demo code, with or without a copy suffix', () => {
    expect(matchDemoFileName('QD6SF3.mp4', { code: 'QD6SF3', title: 'Ocean Crown' })).toBe('ok')
    expect(matchDemoFileName('qd6sf3 (1).mp4', { code: 'QD6SF3', title: 'Ocean Crown' })).toBe('ok')
    expect(matchDemoFileName('QD6SF3.mp4', { code: 'QD6SF3', title: null })).toBe('ok')
  })

  it('mismatch for another game', () => {
    expect(matchDemoFileName('Bloom Dash.mp4', { code: 'QD6SF3', title: 'Drop People!' })).toBe('mismatch')
    expect(matchDemoFileName('Bloom Dash.mp4', { code: null, title: 'Drop People!' })).toBe('mismatch')
  })

  it('mismatch for another game code', () => {
    expect(matchDemoFileName('ZZ7KQ4.mp4', { code: 'QD6SF3', title: 'Ocean Crown' })).toBe('mismatch')
  })

  it('unknown when the game has no title and no code', () => {
    expect(matchDemoFileName('Bloom Dash.mp4', { code: null, title: null })).toBe('unknown')
    expect(matchDemoFileName('Bloom Dash.mp4', { code: '  ', title: '' })).toBe('unknown')
  })

  it('unknown for an empty file name', () => {
    expect(matchDemoFileName('  ', { code: 'QD6SF3', title: 'Ocean Crown' })).toBe('unknown')
  })
})
