# PJ202 – Weekly template tokens

Tokenized template: **Signal Weekly Report Template (tokens)**
https://docs.google.com/presentation/d/1tNMmbUWjlPx5tbde8Nwukjh0b9s8pikhGa8Su-ly3w4/edit
(copy of the user's cleaned template `1A3lcwYcgBBTJMSH-6s7-sabSd75w35VpLAbXVQpcNoc`, which is left untouched; 6 slides, 149 tokens).
Rebuild from a fresh copy with `addtokens.mjs`; regression checks in `tokentest.mjs`.

## How tokens work

Two kinds of locator, because the Slides API cannot put text in images or videos:

- **Text token** – literal `{{name}}` text inside a shape. The exporter reads the duplicated slide, finds the shape whose text contains the token, and replaces it. Replace with "insert new text at the end, then delete the old range" so the run style is kept. Set a hyperlink with `updateTextStyle`.
- **Alt-text token** – the image / video / card background carries `{{name}}` as alt-text title. Groups cannot carry alt text, so a card slot is located through its background shape `{{iN_card}}` and the parent group is deleted to drop the slot.

Tokens are **slot-local** (`i1`..`i8`, `p1`..`p20`, `c1`..`c3`), so the same template slide can be duplicated for the next 8 cards / next game and filled the same way. Read the duplicated slide first: object ids change on duplicate.

## Slides and tokens

| Slide | Text tokens | Alt-text tokens |
|---|---|---|
| 1 Cover | `{{period}}`, `{{report_type}}` | – |
| 2 Insight (8 cards, row-major: left, right, left, right…) | per slot N: `{{iN_name}}` (link = store URL), `{{iN_gameplay}}` (link = video 5'), `{{iN_sep}}` (the "-"), `{{iN_like}} - Like` (link = game-alike store URL), `{{iN_mech}}`, `{{iN_genre}}`, `{{iN_theme}}`, `{{iN_released}}` (app writes "X released by Y") | `{{iN_icon}}`, `{{iN_card}}` |
| 3 Top Picks | `{{p_names_a}}`, `{{p_names_b}}` (multi-line; numbering is literal text, bullets removed, so column b can continue at 10, 12…) | `{{p1_icon}}`..`{{p20_icon}}` (row-major, 4 x 5) |
| 4 Detail, 3 sections | `{{name}}`, `{{release}}`, `{{core}}` (multi-line, one bullet per line), per section c1..c3: `{{cN_game}}`, `{{cN_control}}`, `{{cN_mech}}`, `{{cN_board}}`, `{{cN_theme}}` | `{{icon}}`, `{{video}}`, `{{cN_icon}}` |
| 5 Detail, 2 sections | same, c1..c2 | same |
| 6 Detail, "NEW GAMEPLAY" | `{{name}}`, `{{release}}`, `{{core}}` | `{{icon}}`, `{{video}}` |

Section lines: the app writes the whole line, e.g. `Control (tap to select)`, `Mechanic (sort color, loop queue)`, `Game board`, `Theme (car)`, and deletes a line when its value is empty.

## Verified against a temp copy (all pass)

`replaceImage` on an icon inside a group and on the Top Picks grid; delete the video placeholder and `createVideo` (YouTube id) with the same size and transform; set text plus hyperlink on a token shape; delete a whole card slot; resize a chip with `updatePageElementTransform`. The first attempt at `replaceImage` failed only because the test URL was wrong ("provided image was not found" = the image URL is unreachable).

## Open points for the spec

1. **Chip and pill widths are fixed in the template.** Slides does not fit a shape to its text, so the exporter must compute a width from the text length and move the chips to the left when a chip is removed (Like, Mech, Genre, Theme, and the section headers).
2. **Empty values:** delete the chip / line / card slot (do not leave a token or an empty pill). No game-alike: delete the whole Like chip.
3. **Insight capacity:** template = 8 cards, the sample report packs 10. Follow PRD R-SL3 (duplicate slide after 8).
4. **Top Picks capacity:** 20 icon slots but the sample report lists 21 names, and each names box fits roughly 11 lines. Needs an overflow rule (R-SL4).
5. **Core gameplay length:** template box shows 5 bullets, real games have up to 7 lines (core + game over + level complete). The exporter must shrink the font or split the game.
6. **Sections:** header shows the section kind (game / Feature / Theme). Feature and Theme sections have no game icon, so the exporter should delete the icon or keep the placeholder.
7. **Where the file lives:** the service account only sees the "Weekly Slides" folder, so the tokenized template sits there next to the drafts. Move it (and share it with the service account) if you want it elsewhere.
