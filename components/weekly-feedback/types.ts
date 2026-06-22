export interface GameHit { game_id: string; title: string; app_link: string | null; icon_url: string | null }
export interface GameAlikeGame { game_id: string | null; title: string; app_link: string | null; icon_url: string | null; manual: boolean }
export interface GameAlikeSection { name: string | null; games: GameAlikeGame[] }

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
