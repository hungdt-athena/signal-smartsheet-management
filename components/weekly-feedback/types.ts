export interface GameHit { game_id: string; title: string; app_link: string | null; icon_url: string | null }
export interface GameAlikeGame { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }

// A week is an ordered list of sections. Each section is one 70/30 row: a Tiptap
// feedback doc on the left, and one or more named "game alike" groups on the right.
export interface AlikeBlock { name: string; games: GameAlikeGame[] }
export interface Section { id: string; feedback: unknown; alikes: AlikeBlock[] }

export const hitToGame = (h: GameHit): GameAlikeGame => ({ ...h, manual: false })

export const newSection = (): Section => ({
  id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
  feedback: null,
  alikes: [],
})

export async function searchGames(opts: { q?: string; link?: string }): Promise<GameHit[]> {
  const params = new URLSearchParams()
  if (opts.link) params.set('link', opts.link)
  else if (opts.q) params.set('q', opts.q)
  else return []
  const res = await fetch(`/api/games/search?${params.toString()}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.results as GameHit[]
}
