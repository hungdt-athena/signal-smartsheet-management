import { parsePeopleConfig, visibleEvaluators, DEFAULT_PEOPLE_CONFIG } from '@/lib/people-config'

describe('parsePeopleConfig', () => {
  it('returns the default for an empty or missing blob', () => {
    expect(parsePeopleConfig(null)).toEqual(DEFAULT_PEOPLE_CONFIG)
    expect(parsePeopleConfig('')).toEqual(DEFAULT_PEOPLE_CONFIG)
  })

  it('never throws on a malformed blob — a dropdown must still render', () => {
    expect(parsePeopleConfig('{not json')).toEqual(DEFAULT_PEOPLE_CONFIG)
    expect(parsePeopleConfig('{"hiddenInFilters":"shortcut"}')).toEqual({ hiddenInFilters: [] })
  })

  it('lowercases, trims and dedupes the keys', () => {
    expect(parsePeopleConfig('{"hiddenInFilters":[" Shortcut ","SHORTCUT","ThuDT",""]}'))
      .toEqual({ hiddenInFilters: ['shortcut', 'thudt'] })
  })
})

describe('visibleEvaluators', () => {
  const names = ['MiTT', 'Shortcut', 'ThuDT']

  it('returns the list untouched when nobody is hidden', () => {
    expect(visibleEvaluators(names, [])).toBe(names)
  })

  it('drops hidden people case-insensitively', () => {
    expect(visibleEvaluators(names, ['shortcut'])).toEqual(['MiTT', 'ThuDT'])
    expect(visibleEvaluators(names, ['thudt', 'shortcut'])).toEqual(['MiTT'])
  })

  it('ignores a hidden key that matches nobody', () => {
    expect(visibleEvaluators(names, ['ghost'])).toEqual(names)
  })
})
