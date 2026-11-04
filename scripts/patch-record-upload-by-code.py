#!/usr/bin/env python3
"""Patch workflows/append-sheet.json so a record file named by a 6-char code is matched by code.

    python3 -I scripts/patch-record-upload-by-code.py

Reads  workflows/append-sheet.json             (n8n "Append Sheet", left unchanged)
       workflows/drive-video-link-sync.json    (only for the Postgres node template)
Writes workflows/record-upload-by-code.json    (new workflow "Append Sheet [by-code]", import it INACTIVE)

"Append Sheet" lists the [Signal] Video folder, parses hand-typed `Title_Recorder_Nmins.mp4` names, appends
new files to the `ytb_uploaded` sheet as PENDING and calls "Upload Youtube" (gFnZgEix9Phn3m37), which uploads
every PENDING row. Only this workflow is patched; Upload Youtube reads the sheet and is unchanged.

Flow added between "[NEW] Search Drive" and the existing "[NEW] Parse Filenames":

  [NEW] Search Drive -> Split Record Codes -> Lookup Record Codes (Postgres) -> Read Upload Rows (sheet)
    -> Classify Record Codes -> Plan Record Renames -> Any Record Rename (IF)
          true  -> Rename Record File (Drive) -> Collect Record Files
          false ------------------------------> Collect Record Files
       Collect Record Files -> [NEW] Parse Filenames (unchanged) -> Attach game_id -> [NEW] Compare - Find New
    -> Record Code Notices -> Log Record Notices (flow_log) + Chat Record Notice

Recorder and bucket come from the DB when the file is processed (the Confirmed bucket's assignee). The file
is renamed to the old format, so the legacy path, the sheet formulas and Upload Youtube see what they always
saw. "[NEW] Append PENDING" gets one more column, game_id (empty for hand-named files).

Demo and record videos share the [Signal] Video folder; the code tells them apart, and each workflow acts
only on its own kind. This one silently skips a code that is a demo code (alone or also a record code: the
demo workflow reports that ambiguity). A code mixes letters and digits, so a title never looks like one: a code
known to neither table is a typo and only this workflow reports it (code_not_found); the demo workflow lets it
fall through to title matching, silently. Claimed codes stay untouched and out of the legacy stream.

The 6-char rule is re-implemented in the Code node (n8n cannot import lib/short-code.ts);
__tests__/workflows/record-upload-by-code.test.ts asserts the alphabet equals CODE_ALPHABET.
"""
import copy
import json
import pathlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'workflows' / 'append-sheet.json'
PG_SRC = ROOT / 'workflows' / 'drive-video-link-sync.json'
DST = ROOT / 'workflows' / 'record-upload-by-code.json'
NAME = 'Append Sheet [by-code]'
CHAT_SPACE = 'spaces/AAQAYTKWM1I'
CHAT_CREDENTIAL = {'googleApi': {'id': '5MOpxh9U04GXBIJp', 'name': 'HungDT-Minisoos'}}
SHEETS_CREDENTIAL = {'googleSheetsOAuth2Api': {'id': 'UMl5XCc7aOcf9yi3', 'name': 'HandoverRequest-HungDT'}}

SPLIT_JS = r'''// Files whose whole name (minus one extension and one " (n)" suffix) is a 6-char code go to the code branch.
// Same rule as codeFromFileName in lib/short-code.ts (alphabet, 6 chars, >= 2 digits, >= 2 letters). Keep the alphabet identical (a test checks it).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{6}$');
// A code mixes letters and digits (at least 2 of each), so a real title like "Racket" is never a code.
const MIN_DIGITS = 2;
const MIN_LETTERS = 2;
const isCode = s => {
  if (!CODE_RE.test(s)) return false;
  const digits = (s.match(/[2-9]/g) || []).length;
  return digits >= MIN_DIGITS && 6 - digits >= MIN_LETTERS;
};
const codeFromFileName = name => {
  const base = String(name)
    .replace(/\.[^.]*$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim()
    .toUpperCase();
  return isCode(base) ? base : null;
};

const files = $input.all().map(i => i.json);
const codeFiles = [];
for (const f of files) {
  const code = f && f.id && f.name ? codeFromFileName(f.name) : null;
  if (!code) continue;
  codeFiles.push({ code, id: f.id, name: f.name, mimeType: f.mimeType });
}

if (codeFiles.length === 0) {
  return [{ json: { sql: 'SELECT 1 AS no_codes', codeFiles, files } }];
}

// Only codes go into the SQL (never a file name); quotes are doubled anyway.
const q = s => `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;
const codes = [...new Set(codeFiles.map(c => c.code))];
const values = codes.map(c => `(${q(c)})`).join(', ');

// One row per code. The joins compare the plain columns record_code / demo_code with the code, so the
// partial unique indexes of migration 052 are used (game_info is 5.7 GB: never wrap the row in to_jsonb()).
// Migration 052 MUST be applied before this workflow is activated: without it the column does not exist,
// this query fails and code files are not renamed (legacy name matching only).
// pick: the game's row in the Record tab (record_bucket 5min/20min, or unset with final Insight / Priority IV;
// 'none' = removed), Confirmed rows first. Its own bucket is the Record tab's rule; recorder and Confirm are
// that bucket's. youtube_live: any row of the game already has a YouTube link for that bucket.
const sql =
  `WITH c(code) AS (VALUES ${values})\n` +
  `SELECT c.code, r.game_id::text AS game_id, r.title,\n` +
  `  (d.game_id IS NOT NULL) AS in_demo,\n` +
  `  pick.id AS eval_id, pick.bucket, pick.recorder, pick.confirmed,\n` +
  `  CASE WHEN pick.id IS NULL THEN false ELSE EXISTS (\n` +
  `    SELECT 1 FROM game_evaluations g2\n` +
  `    WHERE g2.game_id::text = r.game_id::text\n` +
  `      AND COALESCE(btrim(CASE pick.bucket WHEN '5min' THEN g2.youtube_5min_link ELSE g2.youtube_20min_link END), '') <> ''\n` +
  `  ) END AS youtube_live\n` +
  `FROM c\n` +
  `LEFT JOIN game_info r ON r.record_code = c.code\n` +
  `LEFT JOIN game_info d ON d.demo_code = c.code\n` +
  `LEFT JOIN LATERAL (\n` +
  `  SELECT ge.id, s.bucket,\n` +
  `    CASE s.bucket WHEN '5min' THEN ge.record_5min_assignee ELSE ge.record_20min_assignee END AS recorder,\n` +
  `    CASE s.bucket WHEN '5min' THEN ge.record_5min_confirmed_at ELSE ge.record_20min_confirmed_at END AS confirmed_at,\n` +
  `    (CASE s.bucket WHEN '5min' THEN ge.record_5min_confirmed_at ELSE ge.record_20min_confirmed_at END) IS NOT NULL AS confirmed\n` +
  `  FROM game_evaluations ge\n` +
  `  CROSS JOIN LATERAL (SELECT CASE\n` +
  `    WHEN ge.record_bucket IN ('5min','20min') THEN ge.record_bucket\n` +
  `    WHEN ge.final_conclusion = 'Priority IV' THEN '20min' ELSE '5min' END AS bucket) s\n` +
  `  WHERE ge.game_id::text = r.game_id::text\n` +
  `    AND (ge.record_bucket IN ('5min','20min')\n` +
  `         OR (ge.record_bucket IS NULL AND ge.final_conclusion IN ('Insight','Priority IV')))\n` +
  `  ORDER BY confirmed DESC, confirmed_at DESC NULLS LAST, ge.id\n` +
  `  LIMIT 1\n` +
  `) pick ON true`;

return [{ json: { sql, codeFiles, files } }];
'''

CLASSIFY_JS = r'''// Decide, per code file, what happens. Input: the ytb_uploaded sheet rows (Read Upload Rows).
//   record code, bucket Confirmed with a recorder, no upload yet -> rename to Title_Recorder_Nmins, legacy path
//   record code, not in Record / not Confirmed / no recorder     -> held_not_confirmed (file untouched)
//   record code, the bucket already has a YouTube link, or the
//     sheet already has an upload of this game + bucket          -> held_youtube_live (file untouched)
//   code in demo_code (alone or also record_code)                -> silent skip: claimed, file untouched, no
//                                                                   notice, not on the legacy stream (the demo
//                                                                   workflow reports an ambiguous code)
//   code in neither column                                       -> code_not_found (file untouched, not legacy)
//   lookup failed (error item / no rows)                         -> code_lookup_failed, nothing renamed
// Files that are not codes go on to the legacy path exactly as Search Drive gave them.
const split = $('Split Record Codes').first().json;
const files = split.files || [];
const codeFiles = split.codeFiles || [];

let lookup = [];
try { lookup = $('Lookup Record Codes').all().map(i => i.json); } catch (e) { lookup = []; }
const byCode = new Map(lookup.filter(r => r && !r.error && r.code).map(r => [String(r.code), r]));

// Same regex as "[NEW] Parse Filenames" and Upload Youtube's "Parse for Upload".
const re = /^([^_]+)_([^_]+)_(\d+)mins(?:\..*)?$/i;
const inFlight = new Set();
for (const row of $input.all().map(i => i.json)) {
  if (!row || row.error || !row.game_id) continue;
  if (String(row.status || '').trim().toUpperCase() === 'FAILED') continue;
  const m = String(row.fileName || '').trim().match(re);
  if (m) inFlight.add(`${String(row.game_id).trim()}|${Number(m[3])}`);
}

// Underscores split the legacy name into title / recorder / minutes, so neither part may contain one.
// Characters Drive and most tools dislike become a space too; runs of spaces collapse.
const clean = s => String(s == null ? '' : s).replace(/[\/\\:*?"<>|_]/g, ' ').replace(/\s+/g, ' ').trim();

const claimed = new Set();
const seen = new Set();
const renames = [];
const notices = [];
const missing = [];

for (const c of codeFiles) {
  claimed.add(c.id);
  const r = byCode.get(c.code);
  if (!r) { missing.push(c); continue; }
  const base = { code: c.code, file: c.name, file_id: c.id };
  if (r.game_id == null) {
    if (!r.in_demo) notices.push({ ...base, status: 'code_not_found' }); // demo code: not ours, silent
    continue;
  }
  const gameId = String(r.game_id);
  const entry = { ...base, game_id: gameId, title: r.title || null };
  if (r.in_demo) continue; // also a demo code: the demo workflow reports it, nothing happens here
  if (r.eval_id == null) {
    notices.push({ ...entry, status: 'held_not_confirmed', reason: 'the game is not in the Record tab (removed, or not Insight / Priority IV)' });
    continue;
  }
  const bucket = r.bucket === '20min' ? '20min' : '5min';
  if (!r.confirmed) {
    notices.push({ ...entry, bucket, status: 'held_not_confirmed', reason: `the ${bucket} record bucket is not Confirmed yet` });
    continue;
  }
  const recorder = clean(r.recorder);
  if (!recorder) {
    notices.push({ ...entry, bucket, status: 'held_not_confirmed', reason: `the ${bucket} record bucket has no recorder` });
    continue;
  }
  const mins = bucket === '20min' ? 20 : 5;
  const key = `${gameId}|${mins}`;
  let held = null;
  if (seen.has(key)) held = 'another file for this game and bucket is handled in this run';
  else if (r.youtube_live) held = `the game already has a ${bucket} YouTube link`;
  else if (inFlight.has(key)) held = `ytb_uploaded already has a ${bucket} upload of this game`;
  if (held) {
    notices.push({ ...entry, bucket, status: 'held_youtube_live', reason: held });
    continue;
  }
  seen.add(key);
  const title = clean(r.title) || clean(gameId);
  const m = String(c.name).match(/\.[^./]*$/);
  const ext = m ? m[0] : '';
  renames.push({
    fileId: c.id, oldName: c.name, newName: `${title}_${recorder}_${mins}mins${ext}`,
    game_id: gameId, code: c.code, bucket, recorder, mimeType: c.mimeType,
  });
}

if (missing.length) {
  notices.push({
    status: 'code_lookup_failed', code: missing.map(c => c.code).join(','),
    file: missing.map(c => c.name).join(', '), file_id: missing.map(c => c.id).join(','),
  });
}

const legacyFiles = files.filter(f => !(f && claimed.has(f.id)));
return [{ json: { renames, notices, legacyFiles } }];
'''

PLAN_JS = r'''// One item per file to rename, or a single skip item so the legacy path always continues.
const renames = $('Classify Record Codes').first().json.renames || [];
return renames.length ? renames.map(json => ({ json })) : [{ json: { skip: true } }];
'''

COLLECT_JS = r'''// Back to one stream for "[NEW] Parse Filenames": the non-code files as Search Drive gave them, plus every
// code file whose rename went through, under its new name. A failed rename (the Drive node continues on
// error) keeps its code name in Drive, is retried on the next run, and is reported once by Record Code
// Notices (rename_failed).
const cls = $('Classify Record Codes').first().json;
const planned = $('Plan Record Renames').all().map(i => i.json);
const outs = $input.all().map(i => i.json);
const files = (cls.legacyFiles || []).map(f => ({ ...f, game_id: '' }));
planned.forEach((p, i) => {
  if (!p || p.skip) return;
  const o = outs[i];
  if (!o || o.error || (o.id && o.id !== p.fileId)) return;
  files.push({ id: p.fileId, name: p.newName, mimeType: p.mimeType, game_id: p.game_id });
});
return files.map(json => ({ json }));
'''

ATTACH_JS = r'''// "[NEW] Parse Filenames" keeps only its own fields; put game_id back for "[NEW] Append PENDING".
const ids = new Map($('Collect Record Files').all().map(i => [String(i.json.id), i.json.game_id || '']));
return $input.all().map(i => ({ json: { ...i.json, game_id: ids.get(String(i.json.fileId)) || '' } }));
'''

NOTICES_JS = r'''// One flow_log row + one Chat message per code file left as it is. A file is reported once per status:
// the workflow lists the last days of the folder on every run, and a held file would otherwise be
// reported again each time. (Workflow static data is kept for production runs only.)
const notices = [...($('Classify Record Codes').first().json.notices || [])];

// A rename the Drive node could not do (it continues on error) is reported here too. n8n runs the rename
// branch before this one (execution order v1, top to bottom); when no rename ran, those nodes are absent.
// Same pairing and failure rule as Collect Record Files. The file keeps its code name and is retried.
let planned = [];
let outs = [];
try { planned = $('Plan Record Renames').all().map(i => i.json); } catch (e) { planned = []; }
try { outs = $('Rename Record File').all().map(i => i.json); } catch (e) { outs = []; }
planned.forEach((p, i) => {
  if (!p || p.skip) return;
  const o = outs[i];
  if (o && !o.error && !(o.id && o.id !== p.fileId)) return;
  const err = o && o.error ? (typeof o.error === 'string' ? o.error : (o.error.message || 'error')) : 'no result from Drive';
  notices.push({ status: 'rename_failed', code: p.code, file: p.oldName, file_id: p.fileId, game_id: p.game_id,
    bucket: p.bucket, reason: String(err).slice(0, 300) });
});

let store = null;
try { store = $getWorkflowStaticData('global'); } catch (e) { store = null; }
const sent = new Set(store && Array.isArray(store.recordNoticeKeys) ? store.recordNoticeKeys : []);

const out = [];
for (const n of notices) {
  const key = `${n.status}|${n.file_id}`;
  if (sent.has(key)) continue;
  sent.add(key);
  const label = n.title ? `${n.title} (${n.game_id})` : n.game_id || '';
  const mins = n.bucket === '20min' ? '20' : '5';
  let text;
  if (n.status === 'code_not_found') {
    text = `append-sheet: No game has the code ${n.code} (file ${n.file}). Check the code in the app. File left as it is.`;
  } else if (n.status === 'rename_failed') {
    text = `append-sheet: could not rename ${n.file} (code ${n.code}) for ${label}. File left as it is and not uploaded; it is retried on the next runs. Check that the n8n Drive account can edit this file.`;
  } else if (n.status === 'held_not_confirmed') {
    text = `append-sheet: ${n.file} (code ${n.code}) is for ${label}, but ${n.reason}. File left as it is; it is processed on a later run once the record bucket is Confirmed with a recorder.`;
  } else if (n.status === 'held_youtube_live') {
    text = `append-sheet: ${n.file} (code ${n.code}) is for ${label}: ${n.reason}. Not uploaded twice. To upload this file, clear the old ${mins} min YouTube link in the Record tab and remove its row from ytb_uploaded; the file is processed on a later run.`;
  } else {
    text = `append-sheet: could not look up record codes for ${n.file}. Files left as they are; they are retried on the next run.`;
  }
  out.push({ json: {
    name: 'append-sheet',
    status: n.status,
    note: JSON.stringify({ file: n.file, code: n.code, game_id: n.game_id || null, bucket: n.bucket || null, reason: n.reason || null }),
    text,
  } });
}
if (store) store.recordNoticeKeys = [...sent].slice(-1000);
return out;
'''


def nid(label):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'record-upload-by-code/' + label))


def code_node(name, js, pos):
    return {'parameters': {'jsCode': js}, 'id': nid(name), 'name': name,
            'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'position': pos}


def main():
    wf = json.loads(SRC.read_text())
    by_name = {n['name']: n for n in wf['nodes']}
    pg_tpl = next(n for n in json.loads(PG_SRC.read_text())['nodes'] if n['name'] == 'Match Titles in DB2')
    rows_tpl = by_name['[NEW] Get Existing Rows']
    log_tpl = by_name['Log flow_log (append-sheet)']
    trigger = by_name['Google Drive Trigger']
    assert log_tpl['credentials'] == SHEETS_CREDENTIAL, log_tpl['credentials']

    # New nodes sit in a row above the legacy chain. Plan Record Renames is above Record Code Notices so that
    # n8n (execution order v1, top to bottom) runs the legacy path before the notices.
    x0, y0 = 448, -560
    nodes = [code_node('Split Record Codes', SPLIT_JS, [x0 + 224, y0])]

    lookup = copy.deepcopy(pg_tpl)
    lookup.update({'id': nid('Lookup Record Codes'), 'name': 'Lookup Record Codes', 'position': [x0 + 448, y0],
                   'onError': 'continueRegularOutput'})
    lookup['parameters'] = {'operation': 'executeQuery', 'query': '{{ $json.sql }}', 'options': {}}
    nodes.append(lookup)

    rows = copy.deepcopy(rows_tpl)
    rows.update({'id': nid('Read Upload Rows'), 'name': 'Read Upload Rows', 'position': [x0 + 672, y0],
                 'executeOnce': True, 'alwaysOutputData': True, 'onError': 'continueRegularOutput'})
    nodes.append(rows)

    nodes.append(code_node('Classify Record Codes', CLASSIFY_JS, [x0 + 896, y0]))
    nodes.append(code_node('Plan Record Renames', PLAN_JS, [x0 + 1120, y0]))
    nodes.append({
        'parameters': {'conditions': {'boolean': [{'value1': '={{ $json.skip !== true }}', 'value2': True}]}},
        'id': nid('Any Record Rename'), 'name': 'Any Record Rename',
        'type': 'n8n-nodes-base.if', 'typeVersion': 1, 'position': [x0 + 1344, y0],
    })
    nodes.append({
        'parameters': {
            'resource': 'file', 'operation': 'update',
            'fileId': {'__rl': True, 'value': '={{ $json.fileId }}', 'mode': 'id'},
            'newUpdatedFileName': '={{ $json.newName }}', 'options': {},
        },
        'id': nid('Rename Record File'), 'name': 'Rename Record File',
        'type': 'n8n-nodes-base.googleDrive', 'typeVersion': 3, 'position': [x0 + 1568, y0 - 112],
        'credentials': copy.deepcopy(trigger['credentials']),
        'onError': 'continueRegularOutput',
    })
    nodes.append(code_node('Collect Record Files', COLLECT_JS, [x0 + 1792, y0]))
    nodes.append(code_node('Attach game_id', ATTACH_JS, [x0 + 2016, y0]))

    nodes.append(code_node('Record Code Notices', NOTICES_JS, [x0 + 1120, y0 + 224]))
    log = copy.deepcopy(log_tpl)
    log.update({'id': nid('Log Record Notices'), 'name': 'Log Record Notices', 'position': [x0 + 1344, y0 + 224],
                'onError': 'continueRegularOutput'})
    nodes.append(log)
    nodes.append({
        'parameters': {'spaceId': CHAT_SPACE, 'jsonParameters': True,
                       'messageJson': '={{ JSON.stringify({ text: $json.text }) }}', 'additionalFields': {}},
        'id': nid('Chat Record Notice'), 'name': 'Chat Record Notice',
        'type': 'n8n-nodes-base.googleChat', 'typeVersion': 1, 'position': [x0 + 1344, y0 + 384],
        'credentials': copy.deepcopy(CHAT_CREDENTIAL),
        'onError': 'continueRegularOutput',
    })

    # The sheet row carries game_id (empty for hand-named files). The column must exist in ytb_uploaded first.
    append = by_name['[NEW] Append PENDING']
    cols = append['parameters']['columns']
    cols['value']['game_id'] = '={{ $json.game_id }}'
    cols['schema'].append({'id': 'game_id', 'displayName': 'game_id', 'required': False, 'defaultMatch': False,
                           'display': True, 'type': 'string', 'canBeUsedToMatch': True})

    # Held files must be retried on a schedule, not only when another file lands. The legacy path is idempotent
    # under repeated runs (Compare - Find New passes on only fileIds that have no ytb_uploaded row in any status,
    # and nothing downstream runs without such a file), so the existing, disconnected Scanner Trigger becomes the
    # one poller, every 10 minutes. The Drive trigger is disabled rather than kept beside it: two pollers firing
    # in the same minute could both read the sheet before either appended and append one file twice. One poller
    # leaves the same overlap profile the legacy Drive trigger had (plus the webhook, unchanged).
    scanner = by_name['[NEW] Scanner Trigger']
    scanner['parameters'] = {'rule': {'interval': [{'field': 'minutes', 'minutesInterval': 10}]}}
    trigger['disabled'] = True

    wf['nodes'] = wf['nodes'] + nodes

    def link(*targets):
        return {'main': [[{'node': t, 'type': 'main', 'index': 0} for t in targets]]}

    c = wf['connections']
    c['[NEW] Scanner Trigger'] = copy.deepcopy(c['Google Drive Trigger'])
    c['[NEW] Search Drive'] = link('Split Record Codes')
    c['Split Record Codes'] = link('Lookup Record Codes')
    c['Lookup Record Codes'] = link('Read Upload Rows')
    c['Read Upload Rows'] = link('Classify Record Codes')
    c['Classify Record Codes'] = link('Plan Record Renames', 'Record Code Notices')
    c['Plan Record Renames'] = link('Any Record Rename')
    c['Any Record Rename'] = {'main': [
        [{'node': 'Rename Record File', 'type': 'main', 'index': 0}],
        [{'node': 'Collect Record Files', 'type': 'main', 'index': 0}],
    ]}
    c['Rename Record File'] = link('Collect Record Files')
    c['Collect Record Files'] = link('[NEW] Parse Filenames')
    c['[NEW] Parse Filenames'] = link('Attach game_id')
    c['Attach game_id'] = link('[NEW] Compare - Find New')
    c['Record Code Notices'] = link('Log Record Notices', 'Chat Record Notice')

    out = {'name': NAME, 'nodes': wf['nodes'], 'connections': c, 'settings': wf.get('settings') or {},
           'pinData': {}, 'meta': wf.get('meta')}
    DST.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
    print(f'wrote {DST.relative_to(ROOT)} ({len(out["nodes"])} nodes)')


if __name__ == '__main__':
    main()
