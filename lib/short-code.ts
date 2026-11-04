import { randomInt } from 'crypto'

// No 0, O, 1, I, L: avoids look-alike characters when a code is read aloud or typed.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

export function generateCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return out
}

export function isCode(s: string): boolean {
  return CODE_RE.test(s)
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
