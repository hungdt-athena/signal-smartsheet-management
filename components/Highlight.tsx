import { splitOnMatch } from '@/lib/eval-search'

/** A label with the searched-for run marked.
 *
 *  Renders `<mark>` around each match rather than styling by hand, so the meaning
 *  ("this is why the row is here") is in the markup and not only in the colour. With
 *  no term, or nothing matching, this is exactly the plain text it was handed. */
export function Highlight({ text, term }: { text: string; term: string }) {
  const parts = splitOnMatch(text, term)
  if (parts.length === 1 && !parts[0].hit) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => p.hit
        ? <mark key={i} className="q-hit">{p.text}</mark>
        : <span key={i}>{p.text}</span>)}
    </>
  )
}
