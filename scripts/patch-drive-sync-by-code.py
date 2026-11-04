#!/usr/bin/env python3
"""Patch workflows/drive-video-link-sync.json so a demo file named by a 6-char code is matched by code.

    python3 -I scripts/patch-drive-sync-by-code.py

Reads  workflows/drive-video-link-sync.json            (title matching only, left unchanged)
Writes workflows/drive-video-link-sync-by-code.json    (new workflow, import it INACTIVE)

Flow added between "List Drive Files2" and the existing title path:

  List Drive Files2 -> Split Code Files -> Lookup Codes (Postgres) -> Classify Codes
      Classify Codes -> Title Files -> Parse File Names2 -> ... (existing title path, untouched)
                     -> Write Code Links -> Plan Renames -> Names Taken -> Resolve Names
                        -> Rename Drive File -> Code Result -> Log Code Result
                     -> Code Notices -> Log Code Notices (flow_log) + Chat Code Notice

A code that exists in neither game_info.demo_code nor record_code is NOT an error: a real title such
as "Racket" is six letters, so that file simply goes on to the title path.

The 6-char rule is re-implemented in the Code node (n8n cannot import lib/short-code.ts);
__tests__/workflows/drive-sync-by-code.test.ts asserts the alphabet equals CODE_ALPHABET.
"""
import copy
import json
import pathlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'workflows' / 'drive-video-link-sync.json'
DST = ROOT / 'workflows' / 'drive-video-link-sync-by-code.json'
NAME = 'drive-video-link-sync [by-code]'
CHAT_SPACE = 'spaces/AAQAYTKWM1I'
CHAT_CREDENTIAL = {'googleApi': {'id': '5MOpxh9U04GXBIJp', 'name': 'HungDT-Minisoos'}}

SPLIT_JS = r'''// Files whose whole name (minus one extension and one " (n)" suffix) is a 6-char code go to the code branch.
// Same rule as codeFromFileName in lib/short-code.ts. Keep the alphabet identical (a test checks it).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp('^[' + CODE_ALPHABET + ']{6}$');
const codeFromFileName = name => {
  const base = String(name)
    .replace(/\.[^.]*$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim()
    .toUpperCase();
  return CODE_RE.test(base) ? base : null;
};

const files = $input.all().map(i => i.json);
const codeFiles = [];
for (const f of files) {
  const code = f && f.name ? codeFromFileName(f.name) : null;
  if (!code) continue;
  codeFiles.push({
    code,
    id: f.id,
    name: f.name,
    drive_link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
  });
}

if (codeFiles.length === 0) {
  return [{ json: { sql: 'SELECT 1 AS no_codes', codeFiles, files } }];
}

// One query for every code: which game owns it as a demo code, is it a record code instead, and
// can the link be written (some evaluation row of that game still has an empty drive_link).
// link_is_this_file: the game's link already points at this very file, so only the rename is missing.
const lit = JSON.stringify(codeFiles.map(c => ({ code: c.code, file_id: c.id, drive_link: c.drive_link })));
const sql =
  `SELECT c.code, c.file_id, c.drive_link,\n` +
  `  d.game_id AS demo_game_id, d.title AS demo_title,\n` +
  `  (r.game_id IS NOT NULL) AS in_record,\n` +
  `  EXISTS (SELECT 1 FROM game_evaluations e WHERE e.game_id = d.game_id AND COALESCE(e.drive_link, '') = '') AS can_write,\n` +
  `  EXISTS (SELECT 1 FROM game_evaluations e WHERE e.game_id = d.game_id AND e.drive_link LIKE '%' || c.file_id || '%') AS link_is_this_file\n` +
  `FROM json_to_recordset($jf$${lit}$jf$::json)\n` +
  `  AS c(code text, file_id text, drive_link text)\n` +
  `LEFT JOIN game_info d ON d.demo_code = c.code\n` +
  `LEFT JOIN game_info r ON r.record_code = c.code`;

return [{ json: { sql, codeFiles, files } }];
'''

CLASSIFY_JS = r'''// Decide, per code file, what happens. Order of preference:
//   known demo code + a link can be written -> write the link, then rename the file to the game title
//   known demo code, link already this file -> only the rename is retried
//   known demo code, game already has a link -> link_exists (file untouched, flow_log + Chat)
//   code only in record_code                -> wrong_folder (file untouched, flow_log + Chat)
//   code in neither table                   -> NOT an error: the file stays on the title path
//                                              (a real title like "Racket" is 6 letters long)
const split = $('Split Code Files').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.code);
const byCode = new Map(rows.map(r => [String(r.code), r]));
const q = s => `'${String(s == null ? '' : s).replace(/'/g, "''")}'`;

const claimed = new Set();
const seenCode = new Set();
const writes = [];
const renames = [];
const notices = [];

for (const c of split.codeFiles) {
  const r = byCode.get(c.code);
  const gameId = r && r.demo_game_id != null ? String(r.demo_game_id) : null;
  const inRecord = !!(r && r.in_record);
  if (gameId == null && !inRecord) continue; // unknown code: title path
  claimed.add(c.id);
  const base = { code: c.code, file: c.name, file_id: c.id, drive_link: c.drive_link };
  if (gameId == null) {
    notices.push({ ...base, status: 'wrong_folder' });
    continue;
  }
  const entry = { ...base, game_id: gameId, title: r.demo_title, file_name: c.name };
  if (seenCode.has(c.code)) {
    notices.push({ ...entry, status: 'link_exists', reason: 'another file with this code was handled in the same run' });
    continue;
  }
  seenCode.add(c.code);
  if (r.can_write) writes.push(entry);
  else if (r.link_is_this_file) renames.push(entry);
  else notices.push({ ...entry, status: 'link_exists', reason: 'the game already has a demo link' });
}

// One statement; only rows with an EMPTY drive_link are touched, for EVERY evaluation row of the game.
let writeSql = 'SELECT 1 AS none';
if (writes.length) {
  const values = writes.map(w => `(${q(w.game_id)}, ${q(w.drive_link)})`).join(',\n    ');
  writeSql =
    `WITH v(game_id, drive_link) AS (VALUES\n    ${values}\n), upd AS (\n` +
    `  UPDATE game_evaluations ge\n` +
    `  SET drive_link = v.drive_link, drive_date = NOW(), updated_at = NOW()\n` +
    `  FROM v\n` +
    `  WHERE ge.game_id::text = v.game_id AND COALESCE(ge.drive_link, '') = ''\n` +
    `  RETURNING ge.game_id\n` +
    `)\n` +
    `SELECT COALESCE((SELECT json_agg(DISTINCT game_id::text) FROM upd), '[]'::json) AS updated`;
}

const titleFiles = split.files.filter(f => !(f && claimed.has(f.id)));
return [{ json: { writeSql, writes, renames, notices, titleFiles } }];
'''

TITLE_FILES_JS = r'''// Hand the files that stay on the title path to the existing, unchanged "Parse File Names2".
// Parse File Names2 skips an item without a name, so an empty placeholder keeps its "no files" log row.
const files = $input.first().json.titleFiles || [];
return files.length ? files.map(json => ({ json })) : [{ json: {} }];
'''

PLAN_JS = r'''// Which files to rename: games the statement really updated, plus retries whose link already is this file.
const cls = $('Classify Codes').first().json;
const updated = new Set(((($input.first() || {}).json || {}).updated || []).map(String));
const key = e => `${e.game_id}|${e.file_id}`;
const written = new Set((cls.writes || []).map(key));
const todo = [
  ...(cls.writes || []).filter(e => updated.has(String(e.game_id))),
  ...(cls.renames || []).filter(e => !written.has(key(e))),
];
if (todo.length === 0) return [];

// Characters Drive and most tools dislike become a space; runs of spaces collapse.
const clean = s => String(s == null ? '' : s).replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
const renames = todo.map(e => {
  const baseName = clean(e.title) || String(e.game_id);
  const m = String(e.file_name || '').match(/\.[^./]*$/);
  const ext = m ? m[0] : '';
  return { file_id: e.file_id, game_id: String(e.game_id), code: e.code, oldName: e.file_name, baseName, ext, newName: baseName + ext };
});

// One Drive query for every planned name, to see which are already taken in the folder.
const folderId = $('Config2').first().json.folderId;
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const names = renames.map(r => `name = '${esc(r.newName)}'`).join(' or ');
const nameQuery = `'${esc(folderId)}' in parents and trashed = false and (${names})`;
return [{ json: { renames, nameQuery } }];
'''

RESOLVE_JS = r'''// A name already in the folder, or planned twice in this run, gets _<game_id> appended.
const plan = $('Plan Renames').first().json.renames;
const taken = new Set($input.all().map(i => i.json && i.json.name).filter(Boolean));
const used = new Set();
const out = [];
for (const r of plan) {
  let newName = r.newName;
  if (taken.has(newName) || used.has(newName)) newName = `${r.baseName}_${r.game_id}${r.ext}`;
  used.add(newName);
  out.push({ json: { fileId: r.file_id, newName, game_id: r.game_id, code: r.code, oldName: r.oldName } });
}
return out;
'''

NOTICES_JS = r'''// One flow_log row + one Chat message per code file that was left as it is.
const notices = $('Classify Codes').first().json.notices || [];
return notices.map(n => {
  const label = n.title ? `${n.title} (${n.game_id})` : n.game_id || '';
  const text = n.status === 'wrong_folder'
    ? `drive-video-link-sync: ${n.file} is a RECORD code (${n.code}) but was dropped in the demo folder. File left as it is; move it to the record folder.`
    : `drive-video-link-sync: ${n.file} carries code ${n.code} for ${label}, which already has a demo link. File left as it is; clear the old link to process it again.`;
  return { json: {
    name: 'drive-video-link-sync',
    status: n.status,
    note: JSON.stringify({ file: n.file, code: n.code, game_id: n.game_id || null, reason: n.reason || null }),
    text,
  } };
});
'''

RESULT_JS = r'''// The Drive node runs with "continue on error", so a failed rename arrives as an item with `error`.
const items = $input.all().map(i => i.json);
const failed = items.filter(j => j && j.error).length;
const renamed = items.length - failed;
return [{ json: {
  name: 'drive-video-link-sync',
  status: failed ? 'rename_failed' : 'code_linked',
  note: JSON.stringify({ renamed, failed, files: items.filter(j => j && j.name).map(j => j.name) }),
} }];
'''


def nid(label):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'drive-video-link-sync-by-code/' + label))


def code_node(name, js, pos):
    return {'parameters': {'jsCode': js}, 'id': nid(name), 'name': name,
            'type': 'n8n-nodes-base.code', 'typeVersion': 2, 'position': pos}


def pg_node(name, query, pos, template):
    n = copy.deepcopy(template)
    n['id'] = nid(name)
    n['name'] = name
    n['position'] = pos
    n['parameters']['query'] = query
    return n


def main():
    wf = json.loads(SRC.read_text())
    by_name = {n['name']: n for n in wf['nodes']}
    pg_tpl = by_name['Match Titles in DB2']
    drive_tpl = by_name['List Drive Files2']
    log_tpl = by_name['Log flow_log2']

    x0, y0 = 3344, 1136
    nodes = [
        code_node('Split Code Files', SPLIT_JS, [x0 - 0, y0 - 480]),
        pg_node('Lookup Codes', '{{ $json.sql }}', [x0 + 224, y0 - 480], pg_tpl),
        code_node('Classify Codes', CLASSIFY_JS, [x0 + 448, y0 - 480]),
        code_node('Title Files', TITLE_FILES_JS, [x0 + 672, y0 - 704]),
        pg_node('Write Code Links', '{{ $json.writeSql }}', [x0 + 672, y0 - 480], pg_tpl),
        code_node('Plan Renames', PLAN_JS, [x0 + 896, y0 - 480]),
    ]
    taken = copy.deepcopy(drive_tpl)
    taken.update({'id': nid('Names Taken'), 'name': 'Names Taken', 'position': [x0 + 1120, y0 - 480],
                  'alwaysOutputData': True})
    taken['parameters'] = {
        'resource': 'fileFolder', 'searchMethod': 'query',
        'queryString': '={{ $json.nameQuery }}', 'returnAll': True, 'filter': {}, 'options': {},
    }
    nodes.append(taken)
    nodes.append(code_node('Resolve Names', RESOLVE_JS, [x0 + 1344, y0 - 480]))
    rename = copy.deepcopy(drive_tpl)
    rename.update({'id': nid('Rename Drive File'), 'name': 'Rename Drive File', 'position': [x0 + 1568, y0 - 480],
                   'onError': 'continueRegularOutput'})
    rename['parameters'] = {
        'resource': 'file', 'operation': 'update',
        'fileId': {'__rl': True, 'value': '={{ $json.fileId }}', 'mode': 'id'},
        'newUpdatedFileName': '={{ $json.newName }}', 'options': {},
    }
    nodes.append(rename)
    nodes.append(code_node('Code Result', RESULT_JS, [x0 + 1792, y0 - 480]))

    def log_node(name, pos):
        n = copy.deepcopy(log_tpl)
        n['id'] = nid(name)
        n['name'] = name
        n['position'] = pos
        return n

    nodes.append(log_node('Log Code Result', [x0 + 2016, y0 - 480]))
    nodes.append(code_node('Code Notices', NOTICES_JS, [x0 + 672, y0 - 256]))
    nodes.append(log_node('Log Code Notices', [x0 + 896, y0 - 256]))
    chat = {
        'parameters': {'spaceId': CHAT_SPACE, 'jsonParameters': True,
                       'messageJson': '={{ JSON.stringify({ text: $json.text }) }}', 'additionalFields': {}},
        'id': nid('Chat Code Notice'), 'name': 'Chat Code Notice',
        'type': 'n8n-nodes-base.googleChat', 'typeVersion': 1, 'position': [x0 + 896, y0 - 96],
        'credentials': copy.deepcopy(CHAT_CREDENTIAL),
    }
    nodes.append(chat)

    wf['nodes'] = wf['nodes'] + nodes

    def link(*targets):
        return {'main': [[{'node': t, 'type': 'main', 'index': 0} for t in targets]]}

    c = wf['connections']
    c['List Drive Files2'] = link('Split Code Files')
    c['Split Code Files'] = link('Lookup Codes')
    c['Lookup Codes'] = link('Classify Codes')
    # Title path first, so a failure in the code path can never stop it.
    c['Classify Codes'] = link('Title Files', 'Write Code Links', 'Code Notices')
    c['Title Files'] = link('Parse File Names2')
    c['Write Code Links'] = link('Plan Renames')
    c['Plan Renames'] = link('Names Taken')
    c['Names Taken'] = link('Resolve Names')
    c['Resolve Names'] = link('Rename Drive File')
    c['Rename Drive File'] = link('Code Result')
    c['Code Result'] = link('Log Code Result')
    c['Code Notices'] = link('Log Code Notices', 'Chat Code Notice')

    wf['name'] = NAME
    wf['pinData'] = {}
    wf.pop('active', None)
    DST.write_text(json.dumps(wf, indent=2, ensure_ascii=False) + '\n')
    print(f'wrote {DST.relative_to(ROOT)} ({len(wf["nodes"])} nodes)')


if __name__ == '__main__':
    main()
