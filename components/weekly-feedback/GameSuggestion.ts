'use client'
import { Extension } from '@tiptap/core'
import { Suggestion, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import { searchGames, GameHit } from './types'
import { looksLikeUrl, platformFromLink } from '@/lib/game-link'

// Store badges (App Store / Google Play) built as raw SVG — this popup is vanilla
// DOM, so it can't use the React <PlatformIcon>; the markup mirrors it.
const IOS_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" aria-label="App Store"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>'
const ANDROID_SVG = '<svg width="17" height="17" viewBox="0 0 24 24" aria-label="Google Play"><path fill="currentColor" d="M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067l-11 10.933c.298.036.612-.043.906-.214l13.324-7.545-3.23-3.174z"/></svg>'
function platformBadge(link: string | null): HTMLSpanElement | null {
  const p = platformFromLink(link)
  if (!p) return null
  const span = document.createElement('span')
  span.className = 'wf-plat'
  span.style.color = p === 'ios' ? 'var(--muted)' : '#1aa260'
  span.innerHTML = p === 'ios' ? IOS_SVG : ANDROID_SVG
  return span
}

export const GameSuggestion = Extension.create({
  name: 'gameSuggestion',
  addProseMirrorPlugins() {
    return [
      Suggestion<GameHit, GameHit>({
        editor: this.editor,
        char: '@',
        allowSpaces: true,
        items: async ({ query }) => {
          const q = query.trim()
          if (!q) return []
          return looksLikeUrl(q) ? await searchGames({ link: q }) : await searchGames({ q })
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).insertContent([
            { type: 'gameMention', attrs: { gameId: props.game_id, title: props.title, href: props.app_link, icon: props.icon_url } },
            { type: 'text', text: ' ' },
          ]).run()
        },
        render: () => {
          let el: HTMLDivElement | null = null
          let items: GameHit[] = []
          let selected = 0
          let onPick: (g: GameHit) => void = () => {}
          const paint = () => {
            if (!el) return
            el.innerHTML = ''
            if (!items.length) { el.style.display = 'none'; return }
            el.style.display = 'block'
            items.forEach((g, i) => {
              const b = document.createElement('button')
              b.type = 'button'
              b.className = 'wf-mention-item' + (i === selected ? ' is-sel' : '')
              if (g.icon_url) { const img = document.createElement('img'); img.src = g.icon_url; img.width = 30; img.height = 30; b.appendChild(img) }
              const s = document.createElement('span'); s.className = 'wf-mention-title'; s.textContent = g.title; b.appendChild(s)
              const plat = platformBadge(g.app_link); if (plat) b.appendChild(plat)
              b.addEventListener('mousedown', (e) => { e.preventDefault(); onPick(g) })
              el!.appendChild(b)
            })
          }
          const place = (rect: DOMRect | null | undefined) => {
            if (!el || !rect) return
            el.style.left = `${rect.left}px`
            el.style.top = `${rect.bottom + 4}px`
          }
          return {
            onStart: (props: SuggestionProps<GameHit, GameHit>) => {
              el = document.createElement('div')
              el.className = 'wf-mention-popup'
              document.body.appendChild(el)
              items = props.items; selected = 0; onPick = (g) => props.command(g)
              place(props.clientRect?.()); paint()
            },
            onUpdate: (props: SuggestionProps<GameHit, GameHit>) => {
              items = props.items; selected = 0; onPick = (g) => props.command(g)
              place(props.clientRect?.()); paint()
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (!items.length) return false
              if (props.event.key === 'ArrowDown') { selected = (selected + 1) % items.length; paint(); return true }
              if (props.event.key === 'ArrowUp') { selected = (selected - 1 + items.length) % items.length; paint(); return true }
              if (props.event.key === 'Enter') { onPick(items[selected]); return true }
              if (props.event.key === 'Escape') { if (el) el.style.display = 'none'; return true }
              return false
            },
            onExit: () => { el?.remove(); el = null },
          }
        },
      }),
    ]
  },
})
