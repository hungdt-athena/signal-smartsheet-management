import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'

const row = (o: Partial<RosterRow> & { id: number; name: string; category_group: RosterRow['category_group'] }): RosterRow => ({
  today_available: true, game_platform: 'all', game_category: 'All', weight: 100, ...o,
})

describe('groupRosterByPerson', () => {
  it('collects all of a person\'s genres into one group, names A to Z', () => {
    const groups = groupRosterByPerson([
      row({ id: 1, name: 'MyTL', category_group: 'puzzle' }),
      row({ id: 2, name: 'NhiLV', category_group: 'arcade' }),
      row({ id: 3, name: 'NhiLV', category_group: 'puzzle' }),
    ])
    expect(groups.map(g => g.name)).toEqual(['MyTL', 'NhiLV'])
    expect(groups[1].rows).toHaveLength(2)
  })

  it('orders a person\'s genres puzzle, arcade, simulation', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'simulation' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'puzzle' }),
    ])
    expect(g.rows.map(r => r.category_group)).toEqual(['puzzle', 'arcade', 'simulation'])
  })

  it('missingGenres lists the genres they do not have, in the standard order', () => {
    const [g] = groupRosterByPerson([row({ id: 1, name: 'A', category_group: 'arcade' })])
    expect(g.missingGenres).toEqual(['puzzle', 'simulation'])
  })

  it('missingGenres is empty for someone covering all three', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'simulation' }),
    ])
    expect(g.missingGenres).toEqual([])
  })

  it('today_available is per person: rows disagreeing still yield one value', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle', today_available: false }),
      row({ id: 2, name: 'A', category_group: 'arcade', today_available: true }),
    ])
    expect(typeof g.today_available).toBe('boolean')
    expect(g.today_available).toBe(false)
  })

  it('an empty roster yields an empty list', () => {
    expect(groupRosterByPerson([])).toEqual([])
  })
})
