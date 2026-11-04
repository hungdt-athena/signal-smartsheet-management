import { randomInt } from 'crypto'

// No 0, O, 1, I, L: avoids look-alike characters when a code is read aloud or typed.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
// A real game title is letters only ("Racket"), so a code must mix both: it can then never look like a title.
export const MIN_DIGITS = 2
export const MIN_LETTERS = 2
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

export function generateCode(): string {
  // Rejection sampling: the rule is satisfied by the vast majority of draws.
  for (;;) {
    let out = ''
    for (let i = 0; i < CODE_LENGTH; i++) {
      out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    }
    if (isCode(out)) return out
  }
}

export function isCode(s: string): boolean {
  if (!CODE_RE.test(s)) return false
  const digits = (s.match(/[2-9]/g) || []).length
  return digits >= MIN_DIGITS && CODE_LENGTH - digits >= MIN_LETTERS
}

/** Code from a file name: strip one extension, one " (n)" suffix, trim, upper-case. */
export function codeFromFileName(fileName: string): string | null {
  const base = fileName
    .replace(/\.[^.]*$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim()
    .toUpperCase()
  return isCode(base) ? base : null
}
