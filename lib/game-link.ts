// Parses App Store / Google Play URLs into a platform + store id used to match
// against game_info. Pure + dependency-free so it runs identically on client and server.

export type StorePlatform = 'ios' | 'android'
export interface ParsedStoreLink { platform: StorePlatform; storeId: string }

export function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim())
}

export function parseStoreLink(input: string): ParsedStoreLink | null {
  const s = (input || '').trim()
  if (!s) return null

  if (/apps\.apple\.com/i.test(s)) {
    const m = s.match(/\/id(\d+)/i)
    if (m) return { platform: 'ios', storeId: m[1] }
  }

  if (/play\.google\.com/i.test(s)) {
    const m = s.match(/[?&]id=([a-zA-Z0-9._]+)/)
    if (m) return { platform: 'android', storeId: m[1] }
  }

  return null
}
