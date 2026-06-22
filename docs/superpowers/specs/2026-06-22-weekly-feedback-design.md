# Weekly Feedback — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design), pending implementation
**Owner:** khangna@athena.studio

## Goal

Add a **Weekly Feedback** tab that replaces the manual "Game Trends" Google Sheets.
Each week (batch), **each evaluator writes their own feedback**. A feedback record has
two parts: a rich-text **Feedback** body and a structured **Game Alike** list. Games are
inserted by **pasting a store link (auto-matched against the DB)** or by **typing a name to
search the DB** — the same mechanic in both parts.

## Decisions (locked during brainstorming)

| Topic | Decision |
|---|---|
| Ownership | Each evaluator owns their own feedback per batch (own-only, like Evaluations). |
| Scope | One **general** weekly feedback per evaluator (NOT split by puzzle/arcade/sim). |
| Editor | Tiptap (Google-Docs-like: bold/italic/underline/link/newlines). |
| Game Alike | **Structured** sections (optional name → list of game chips). |
| Batch source | **Reuse** distinct `batch` labels from `game_evaluations` (union all categories). |
| Game insert | **Both**: paste store link (auto-match DB) OR type name to search DB; manual fallback. |
| Admin view | Evaluator **picker** (read-only on others; edits only own). |
| Save | Explicit **Save** button + unsaved-guard (no autosave). |
| Views | Batch view (dropdown → editor) + List view (read-only table, click row → edit). |

## Non-goals (v1)

- No import of historical Google Sheet "Game Trends" data.
- No per-category feedback.
- No real-time collaboration / comments / version history.
- Admins do not edit other evaluators' feedback (read-only).

## Data Model — migration `017_weekly_feedback.sql`

```sql
CREATE TABLE IF NOT EXISTS weekly_feedback (
  id          SERIAL PRIMARY KEY,
  batch       VARCHAR(40)  NOT NULL,        -- week label, e.g. "W1 Jun, 2026"
  evaluator   VARCHAR(100) NOT NULL,        -- owner name (matches game_evaluations.initial_evaluator convention)
  feedback    JSONB,                        -- Tiptap document JSON (rich text + inline game hyperlinks)
  game_alike  JSONB NOT NULL DEFAULT '[]',  -- structured sections (shape below)
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(batch, evaluator)
);

CREATE INDEX IF NOT EXISTS idx_weekly_feedback_evaluator ON weekly_feedback(lower(evaluator));
CREATE INDEX IF NOT EXISTS idx_weekly_feedback_batch ON weekly_feedback(batch);

-- reuse the existing updated_at trigger pattern (see migration 005)
CREATE TRIGGER trg_weekly_feedback_updated
  BEFORE UPDATE ON weekly_feedback
  FOR EACH ROW EXECUTE FUNCTION update_game_evaluations_timestamp();
```

`game_alike` JSON shape:

```json
[
  {
    "name": "Gameplay Loop - TapAway",
    "games": [
      { "game_id": "6757068097", "title": "MakeUp Flow App", "app_link": "https://apps.apple.com/...", "icon_url": "https://...", "manual": false },
      { "game_id": null, "title": "Workers Flow", "app_link": "https://...", "manual": true }
    ]
  }
]
```

- `name` may be `null`/empty (unnamed section).
- `manual: true` = game not found in DB (typed title + pasted link, no icon guaranteed).

`feedback` JSON = Tiptap doc. Inline games are stored as **Link marks** (`href = app_link`,
text = title) so the body renders as hyperlinks exactly like the current sheets.

## Game Matching (link paste)

- iOS App Store links contain a numeric id (`.../id6757068097`); Google Play links contain
  `?id=<package.name>`.
- On paste: extract the store id, look up `game_info` by `game_id` and/or `app_link`
  substring. If found → fill `title`, `app_link`, `icon_url`, set `manual: false`.
- If not found → keep the pasted link, prompt for a typed title, set `manual: true`.
- **TO VERIFY in implementation:** exact relationship between `game_info.game_id` and the
  store id in `app_link` (iOS numeric vs. Play package). Build the matcher against real rows.

## APIs (Next.js route handlers, `app/api/...`)

All reuse the own-only gate from `app/api/evaluations/route.ts:20-26,66`:
`isManager = SKIP_AUTH || role ∈ {admin, moderator}`; non-managers forced to
`session.user.name`; match `lower(evaluator) = lower(...)`.

1. `GET /api/games/search?q=…&link=…`
   - `q` → `game_info WHERE title ILIKE %q% AND is_active`, prefix matches first, limit 10.
   - `link` → extract store id, match `game_id`/`app_link`.
   - Returns `[{ game_id, title, app_link, icon_url }]`.
   - Powers BOTH the Feedback `@`/link insert and Game Alike's add-game.

2. `GET /api/weekly-feedback/batches`
   - `SELECT DISTINCT batch FROM game_evaluations WHERE batch IS NOT NULL`,
     ordered most-recent first (order by `max(assigned_date)` or `max(imported_at)` per batch).

3. `GET /api/weekly-feedback?evaluator=…` (list view) → all batches for one evaluator.

4. `GET /api/weekly-feedback?batch=…&evaluator=…` → single record (or empty).

5. `PUT /api/weekly-feedback` → upsert `{ batch, feedback, game_alike }` on `(batch, evaluator)`.
   - `evaluator` is **server-resolved** to the session user (own-only); admins cannot write to
     others (return 403 if `?evaluator` ≠ own and not own).

## UI

New route `app/(manager)/weekly-feedback/page.tsx`. Nav entry in `app/(manager)/layout.tsx`
(`roles: ['admin','moderator','evaluator']`), with a view toggle via query param:

- `?view=batch` (default): batch `<select>` (from `/batches`) → renders editor for selected week.
- `?view=list`: read-only table, rows = weeks, columns = Feedback | Game Alike (rendered).
  Click a row → navigate to `?view=batch&batch=…` for editing.
- Admin/moderator only: evaluator picker above both views (reuse the Evaluations tab picker
  pattern). Evaluators see no picker (locked to self).

### Components

- `components/weekly-feedback/FeedbackEditor.tsx` — Tiptap (`StarterKit` + `Underline` +
  `Link` + custom game-insert: paste-link auto-match + `@`-name suggestion popup).
- `components/weekly-feedback/GameAlikeEditor.tsx` — section list (add/remove/reorder); each
  section = optional name input + game chips; add-game uses shared search (link or name).
- `components/weekly-feedback/GameSearch.tsx` — shared search/suggest logic + link parsing.
- `components/weekly-feedback/FeedbackView.tsx` — read-only renderer of `feedback` JSON +
  `game_alike` for the list view.

### Dependencies (new)

`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-underline`,
`@tiptap/extension-link`, `@tiptap/suggestion` (custom popup — no extra UI lib).

### Save / guard

Explicit **Save** button calling `PUT /api/weekly-feedback`. Reuse `lib/unsaved-guard.ts` to
warn on navigation away with unsaved changes.

## Testing

- Unit: link parser (iOS id, Play package, junk input), own-only gate (evaluator forced),
  batch list ordering, `game_alike` round-trip serialization.
- Integration: `PUT` upsert on `(batch, evaluator)`; admin read other vs. write-block (403).
- Manual: editor formatting + paste-link + `@`-search; list↔batch view navigation.
```
