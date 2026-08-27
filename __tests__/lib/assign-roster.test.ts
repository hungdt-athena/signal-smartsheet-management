import { groupRosterByPerson, type RosterRow } from '@/lib/assign-roster'

const row = (o: Partial<RosterRow> & { id: number; name: string; category_group: RosterRow['category_group'] }): RosterRow => ({
  today_available: true, game_platform: 'all', game_category: 'All', weight: 100, ...o,
})

describe('groupRosterByPerson', () => {
  it('gom mọi genre của một người vào một group, sort tên A→Z', () => {
    const groups = groupRosterByPerson([
      row({ id: 1, name: 'MyTL', category_group: 'puzzle' }),
      row({ id: 2, name: 'NhiLV', category_group: 'arcade' }),
      row({ id: 3, name: 'NhiLV', category_group: 'puzzle' }),
    ])
    expect(groups.map(g => g.name)).toEqual(['MyTL', 'NhiLV'])
    expect(groups[1].rows).toHaveLength(2)
  })

  it('trong một người, genre theo thứ tự puzzle → arcade → simulation', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'simulation' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'puzzle' }),
    ])
    expect(g.rows.map(r => r.category_group)).toEqual(['puzzle', 'arcade', 'simulation'])
  })

  it('missingGenres liệt kê genre người đó chưa có, theo thứ tự chuẩn', () => {
    const [g] = groupRosterByPerson([row({ id: 1, name: 'A', category_group: 'arcade' })])
    expect(g.missingGenres).toEqual(['puzzle', 'simulation'])
  })

  it('người đủ 3 genre thì missingGenres rỗng', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle' }),
      row({ id: 2, name: 'A', category_group: 'arcade' }),
      row({ id: 3, name: 'A', category_group: 'simulation' }),
    ])
    expect(g.missingGenres).toEqual([])
  })

  it('today_available lấy theo người: dữ liệu lệch giữa các dòng vẫn ra một giá trị', () => {
    const [g] = groupRosterByPerson([
      row({ id: 1, name: 'A', category_group: 'puzzle', today_available: false }),
      row({ id: 2, name: 'A', category_group: 'arcade', today_available: true }),
    ])
    expect(typeof g.today_available).toBe('boolean')
    expect(g.today_available).toBe(false)
  })

  it('roster rỗng ra mảng rỗng', () => {
    expect(groupRosterByPerson([])).toEqual([])
  })
})
