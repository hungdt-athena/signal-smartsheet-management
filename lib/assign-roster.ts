// lib/assign-roster.ts — gom dòng evaluator_roster theo người cho bảng Assign
// một trang. Một dòng DB = một cặp (người, genre); bảng hiển thị gom chúng lại
// để cột Evaluator và Available gộp cell theo người.
import { BUCKETS, type Bucket } from '@/lib/buckets'

export interface RosterRow {
  id: number
  name: string
  category_group: Bucket
  today_available: boolean
  game_platform: string
  game_category: string
  weight: number
}

export interface PersonGroup {
  name: string
  today_available: boolean
  rows: RosterRow[]
  missingGenres: Bucket[]
}

const bucketRank = (b: string): number => {
  const i = (BUCKETS as readonly string[]).indexOf(b)
  return i === -1 ? BUCKETS.length : i
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })

export function groupRosterByPerson(rows: RosterRow[]): PersonGroup[] {
  const buckets = new Map<string, RosterRow[]>()
  for (const r of rows) {
    const list = buckets.get(r.name)
    if (list) list.push(r)
    else buckets.set(r.name, [r])
  }

  return Array.from(buckets.entries())
    .sort((a, b) => byName(a[0], b[0]))
    .map(([name, list]) => {
      const sorted = [...list].sort((a, b) => bucketRank(a.category_group) - bucketRank(b.category_group))
      const have = new Set(sorted.map(r => r.category_group))
      return {
        name,
        // Available là dữ kiện cấp người. Nếu các dòng lệch nhau thì đó là dữ
        // liệu cũ từ thời 3 tab; group lấy giá trị của dòng đầu và mọi lần ghi
        // đều ghi lại toàn bộ dòng cùng tên, nên nó tự hết lệch sau lần sửa đầu.
        today_available: sorted[0].today_available,
        rows: sorted,
        missingGenres: BUCKETS.filter(b => !have.has(b)),
      }
    })
}
