import {
  CODE_ALPHABET,
  generateCode,
  isCode,
  codeFromFileName,
} from '@/lib/short-code'

describe('generateCode', () => {
  it('returns 6 chars from the alphabet, none of 0O1IL', () => {
    for (let i = 0; i < 1000; i++) {
      const c = generateCode()
      expect(c).toHaveLength(6)
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch)
      expect(c).not.toMatch(/[0O1IL]/)
      expect(isCode(c)).toBe(true)
    }
  })
})

describe('codeFromFileName', () => {
  const cases: Array<[string, string | null]> = [
    ['K7M2QX.mp4', 'K7M2QX'],
    ['k7m2qx.MP4', 'K7M2QX'],
    ['K7M2QX (1).mp4', 'K7M2QX'],
    ['K7M2QX .mp4', 'K7M2QX'],
    ['K7M2QX.mp4.mp4', null],
    ['K7M2QX_20mins.mp4', null],
    ['K7M2Q.mp4', null],
    ['K7M2QXA.mp4', null],
    ['K7M2O1.mp4', null],
    ['Racket.mp4', 'RACKET'],
  ]
  it.each(cases)('%s -> %s', (name, expected) => {
    expect(codeFromFileName(name)).toBe(expected)
  })
})
