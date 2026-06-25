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

// Normalise a user-typed link into a form that survives href sanitisation
// (isSafeHref). A bare domain like "google.com" gets an https:// scheme so it
// isn't stripped on save; explicit schemes, protocol-relative, root-relative
// and anchor links are left untouched. Empty in → empty out.
export function normalizeUrl(input: string): string {
  const s = (input || '').trim()
  if (!s) return s
  if (/^(https?:\/\/|mailto:|tel:|\/\/|\/|#)/i.test(s)) return s
  return 'https://' + s
}

// Lighter than parseStoreLink: just identifies the store a link points at (no
// id extraction), for showing a platform icon next to a game. Null if neither.
export function platformFromLink(link: string | null | undefined): StorePlatform | null {
  if (!link) return null
  if (/apps\.apple\.com/i.test(link)) return 'ios'
  if (/play\.google\.com/i.test(link)) return 'android'
  return null
}
