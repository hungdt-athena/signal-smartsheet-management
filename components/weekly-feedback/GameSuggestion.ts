'use client'
import { Extension } from '@tiptap/core'
import { Suggestion, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import { searchGames, GameHit } from './types'
import { looksLikeUrl } from '@/lib/game-link'

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
              if (g.icon_url) { const img = document.createElement('img'); img.src = g.icon_url; img.width = 18; img.height = 18; b.appendChild(img) }
              const s = document.createElement('span'); s.textContent = g.title; b.appendChild(s)
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
