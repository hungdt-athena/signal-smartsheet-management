// Advance widths of Oswald Bold (wght 700), the Master Template's font, in em, for printable
// ASCII. Read from Google Fonts' Oswald[wght].ttf with fontTools (2026-11-03). Used to tell
// whether a game name fits its text box before Slides lays it out. Pure.

const W: Record<string, number> = {
  " ": 0.256, "!": 0.257, "\"": 0.36, "#": 0.534, "$": 0.485, "%": 1.006, "&": 0.57, "'": 0.17,
  "(": 0.338, ")": 0.328, "*": 0.423, "+": 0.449, ",": 0.238, "-": 0.324, ".": 0.244, "/": 0.422,
  "0": 0.55, "1": 0.385, "2": 0.514, "3": 0.514, "4": 0.524, "5": 0.509, "6": 0.538, "7": 0.439,
  "8": 0.521, "9": 0.538, ":": 0.278, ";": 0.285, "<": 0.398, "=": 0.442, ">": 0.398, "?": 0.483,
  "@": 0.95, "A": 0.551, "B": 0.588, "C": 0.563, "D": 0.586, "E": 0.447, "F": 0.434, "G": 0.582,
  "H": 0.61, "I": 0.301, "J": 0.349, "K": 0.567, "L": 0.443, "M": 0.704, "N": 0.561, "O": 0.586,
  "P": 0.571, "Q": 0.586, "R": 0.6, "S": 0.514, "T": 0.445, "U": 0.588, "V": 0.526, "W": 0.697,
  "X": 0.515, "Y": 0.493, "Z": 0.433, "[": 0.332, "\\": 0.422, "]": 0.324, "^": 0.476, "_": 0.368,
  "`": 0.307, "a": 0.46, "b": 0.506, "c": 0.468, "d": 0.503, "e": 0.47, "f": 0.32, "g": 0.502,
  "h": 0.509, "i": 0.265, "j": 0.269, "k": 0.51, "l": 0.274, "m": 0.753, "n": 0.507, "o": 0.483,
  "p": 0.505, "q": 0.504, "r": 0.383, "s": 0.424, "t": 0.351, "u": 0.504, "v": 0.421, "w": 0.597,
  "x": 0.442, "y": 0.448, "z": 0.392, "{": 0.374, "|": 0.262, "}": 0.379, "~": 0.481,
}

/** Anything outside the table (accents, CJK...) counts as a wide glyph. */
const FALLBACK_EM = 0.6

/** Width of `text` in points at `fontPt`. */
export function textWidthPt(text: string, fontPt: number): number {
  let em = 0
  for (const ch of text) em += W[ch] ?? FALLBACK_EM
  return em * fontPt
}
