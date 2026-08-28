import {
  DEFAULT_GENRE_CONFIG,
  parseGenreConfig,
  resolveGenreTargets,
} from '@/lib/genre-config'

describe('parseGenreConfig', () => {
  it('defaults to puzzle on, the other genres off', () => {
    expect(parseGenreConfig(null)).toEqual({ puzzle: true, arcade: false, simulation: false })
    expect(DEFAULT_GENRE_CONFIG).toEqual({ puzzle: true, arcade: false, simulation: false })
  })

  it('reads an explicit blob', () => {
    expect(parseGenreConfig('{"puzzle":false,"arcade":true,"simulation":true}'))
      .toEqual({ puzzle: false, arcade: true, simulation: true })
  })

  it('falls back to the defaults on malformed json', () => {
    expect(parseGenreConfig('{oops')).toEqual(DEFAULT_GENRE_CONFIG)
  })

  it('ignores unknown genres and fills missing ones from the defaults', () => {
    expect(parseGenreConfig('{"rpg":true,"arcade":true}'))
      .toEqual({ puzzle: true, arcade: true, simulation: false })
  })

  it('treats a non-boolean value as off', () => {
    expect(parseGenreConfig('{"arcade":"yes"}').arcade).toBe(false)
  })
})

describe('resolveGenreTargets', () => {
  const cfg = { puzzle: true, arcade: true, simulation: false }

  it('is active only when the genre is on AND someone is available', () => {
    const targets = resolveGenreTargets(cfg, { puzzle: 7, arcade: 0, simulation: 3 })
    expect(targets).toEqual([
      { bucket: 'puzzle', enabled: true, available: 7, active: true },
      { bucket: 'arcade', enabled: true, available: 0, active: false },
      { bucket: 'simulation', enabled: false, available: 3, active: false },
    ])
  })

  it('reports every genre, in a fixed order, even with no availability data', () => {
    expect(resolveGenreTargets(cfg, {}).map(t => t.bucket)).toEqual(['puzzle', 'arcade', 'simulation'])
    expect(resolveGenreTargets(cfg, {}).every(t => t.active === false)).toBe(true)
  })
})
