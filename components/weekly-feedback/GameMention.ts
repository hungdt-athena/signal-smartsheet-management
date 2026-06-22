import { Node, mergeAttributes } from '@tiptap/core'

// Atomic inline node: an inserted game renders as a single chip/link and is
// deleted as one unit. Stored in the Tiptap JSON doc; rendered to an <a> chip.
export const GameMention = Node.create({
  name: 'gameMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      gameId: { default: null },
      title: { default: '' },
      href: { default: null },
      icon: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-game-mention]' }]
  },

  renderHTML({ node }) {
    const { title, href, gameId, icon } = node.attrs as { title: string; href: string | null; gameId: string | null; icon: string | null }
    return ['a', mergeAttributes({
      'data-game-mention': '',
      'data-game-id': gameId ?? '',
      'data-icon': icon ?? '',
      class: 'wf-mention',
      href: href || undefined,
      target: '_blank',
      rel: 'noopener noreferrer',
    }), title]
  },

  renderText({ node }) {
    return (node.attrs as { title: string }).title
  },
})
