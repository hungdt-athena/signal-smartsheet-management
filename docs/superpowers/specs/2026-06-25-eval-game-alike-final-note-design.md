# Eval: Game Alike + Final Note

Date: 2026-06-25

## Goal

Add two fields to the evaluation flow, reusing weekly-feedback's "Game Alike" UX:

1. **Game Alike** — a flat list of similar games (reuse `GameSearch` widget + chips).
2. **Final Note** — manager-only free text.
3. Rename existing "Note" label → "Initial Note" (DB column `initial_note` unchanged).

## Database — `migrations/020_eval_game_alike_final_note.sql`

```sql
ALTER TABLE game_evaluations
  ADD COLUMN IF NOT EXISTS game_alike JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS final_note TEXT;
```

- `game_alike`: `GameAlikeGame[]` — `{ game_id, title, app_link, icon_url, manual }` (flat list, no named groups). Reuse type from `components/weekly-feedback/types.ts`.
- `final_note`: plain text.

## Evaluation form — `components/EvalDetailPanel.tsx`

- Label **"Note" → "Initial Note"**. Textarea bound to `initial_note`, edit gating unchanged (`canEditEval`).
- **Game Alike** below Initial Note: reuse `GameSearch.tsx` + chip rendering. Single flat list. Editable when `canEditEval` (eval owner or manager). Bound to `game_alike`.
- **Final Note** (bottom): textarea. Editable only by managers (`isManager` = admin | moderator). Non-managers see read-only (disabled). Bound to `final_note`.
- Include `game_alike` + `final_note` in the PATCH body.

## Short List — `app/(manager)/evaluations/page.tsx`

Columns change from:
`# | Game | Link | Final Conclusion | Demo Video | Note | Assigned | Evaluated`
to:
`# | Game | Link | Final Conclusion | Demo Video | Initial Note | Final Note | Game Alike`

- **"Note" → "Initial Note"** header (still read-only, shows `initial_note`).
- **Final Note** (new): inline-editable cell modeled on `FinalConclusionCell` — click → textarea → save/cancel. Manager-only edit; non-managers read-only. PATCH `{ id, final_note }`.
- **Remove** the two date columns (Assigned, Evaluated).
- **Game Alike** (last column, read-only): render chips (icon + title), reuse `AlikeCell`/chip layout from `FeedbackView.tsx`.
- Add `game_alike`, `final_note` to `ShortListItem` interface.

## API — `app/api/evaluations/`

- **GET `[gameId]/route.ts`**: add `ge.game_alike, ge.final_note` to SELECT.
- **GET list (`route.ts`)**: add `ge.game_alike, ge.final_note` to SELECT.
- **PATCH `route.ts`**: accept `game_alike` and `final_note`.
  - `game_alike`: gate to `canEditEval` (owner or manager). Sanitize entries reusing `isSafeHref` from `lib/weekly-feedback.ts` (strip unsafe `app_link`).
  - `final_note`: gate to managers only — return 403 if a non-manager attempts to set it.

## Reuse (do not rewrite)

`GameSearch.tsx`, type `GameAlikeGame`, chip CSS (`.wf-chip*`, `.wf-gamesearch`, `.wf-chips`), `isSafeHref`, endpoint `/api/games/search`.

## Out of scope

- No named game-alike groups (weekly-feedback's `AlikeBlock[]`) — flat list only.
- No change to `initial_note` storage or its edit gating.
- No history/snapshot for these fields.
