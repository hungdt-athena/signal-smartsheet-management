// Adds {{tokens}} (text) and alt-text titles (images/video/groups) to a COPY of the Weekly template.
// Usage: SA_KEY=... node addtokens.mjs <sourceTemplateId> <targetFolderId> "<new name>"
import fs from 'fs';
import { google } from 'googleapis';
const auth = new google.auth.GoogleAuth({ keyFile: process.env.SA_KEY, scopes: ['https://www.googleapis.com/auth/presentations','https://www.googleapis.com/auth/drive'] });
const slides = google.slides({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });
const [srcId, folderId, newName] = process.argv.slice(2);

// ---------- geometry helpers ----------
const mul = (p, c) => ({ // parent ∘ child affine
  scaleX: p.scaleX * c.scaleX + p.shearX * c.shearY, shearX: p.scaleX * c.shearX + p.shearX * c.scaleY, translateX: p.scaleX * c.translateX + p.shearX * c.translateY + p.translateX,
  shearY: p.shearY * c.scaleX + p.scaleY * c.shearY, scaleY: p.shearY * c.shearX + p.scaleY * c.scaleY, translateY: p.shearY * c.translateX + p.scaleY * c.translateY + p.translateY });
const norm = t => ({ scaleX: t?.scaleX ?? 1, scaleY: t?.scaleY ?? 1, shearX: t?.shearX ?? 0, shearY: t?.shearY ?? 0, translateX: t?.translateX ?? 0, translateY: t?.translateY ?? 0 });
const ID = norm({});
function flat(els, parent = ID, chain = []) {
  const out = [];
  for (const e of els) {
    const abs = mul(parent, norm(e.transform));
    const w = (e.size?.width?.magnitude ?? 0) * abs.scaleX, h = (e.size?.height?.magnitude ?? 0) * abs.scaleY;
    const text = e.shape?.text ? e.shape.text.textElements.map(t => t.textRun?.content ?? '').join('') : '';
    const rec = { id: e.objectId, e, x: abs.translateX / 12700, y: abs.translateY / 12700, w: w / 12700, h: h / 12700, text,
      kind: e.elementGroup ? 'group' : e.image ? 'image' : e.video ? 'video' : e.shape ? 'shape' : e.line ? 'line' : 'other', chain, top: chain.length === 0 };
    out.push(rec);
    if (e.elementGroup) out.push(...flat(e.elementGroup.children, abs, [...chain, e.objectId]));
  }
  return out;
}
const strip = s => s.replace(/\n$/, '');
const reqs = []; // per-slide request list
const R = { alt: (id, title) => ({ updatePageElementAltText: { objectId: id, title, description: title } }) };

// replace the text of one paragraph-less shape (single paragraph) keeping run style: insert at end THEN delete original
function replaceAll(el, token) {
  const t = strip(el.text), L = t.length;
  return [{ insertText: { objectId: el.id, insertionIndex: L, text: token } }, { deleteText: { objectId: el.id, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: L } } }];
}
// replace each paragraph i with tokens[i] (descending so indices stay valid)
function replaceParas(el, tokens) {
  const paras = el.text.split('\n'); if (paras[paras.length - 1] === '') paras.pop();
  const starts = []; let s = 0; for (const p of paras) { starts.push(s); s += p.length + 1; }
  const out = [];
  for (let i = paras.length - 1; i >= 0; i--) {
    if (tokens[i] == null) continue;
    out.push({ insertText: { objectId: el.id, insertionIndex: starts[i] + paras[i].length, text: tokens[i] } });
    out.push({ deleteText: { objectId: el.id, textRange: { type: 'FIXED_RANGE', startIndex: starts[i], endIndex: starts[i] + paras[i].length } } });
  }
  return out;
}
// collapse a multi-paragraph shape to ONE paragraph holding `token` (first paragraph style kept)
function collapse(el, token) {
  const paras = el.text.split('\n'); if (paras[paras.length - 1] === '') paras.pop();
  const L1 = paras[0].length, total = el.text.length; // total includes final \n
  const out = [{ insertText: { objectId: el.id, insertionIndex: L1, text: token } }, { deleteText: { objectId: el.id, textRange: { type: 'FIXED_RANGE', startIndex: 0, endIndex: L1 } } }];
  const newTotal = token.length + (total - L1);
  if (paras.length > 1) out.push({ deleteText: { objectId: el.id, textRange: { type: 'FIXED_RANGE', startIndex: token.length, endIndex: newTotal - 1 } } });
  return out;
}

// ---------- copy ----------
let dstId = process.env.RESUME_ID;
if (!dstId) { const copy = await drive.files.copy({ fileId: srcId, supportsAllDrives: true, requestBody: { name: newName, parents: [folderId] }, fields: 'id,name,parents,driveId' }); dstId = copy.data.id; console.log('copied ->', dstId); }
const pres = (await slides.presentations.get({ presentationId: dstId })).data;
const S = pres.slides.map(s => ({ id: s.objectId, els: flat(s.pageElements) }));
const all = [];
const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : null;
const want = i => !only || only.includes(i);

// slide 1 – cover
if (want(0)) {
  const el = S[0].els.find(e => e.text.includes('Monthly Report'));
  const paras = el.text.split('\n'); // ['December 2026','Monthly Report','']
  all.push({ slide: 0, r: replaceParas(el, ['{{period}}', '{{report_type}}']) });
}
// slide 2 – Insight, 8 slots row-major
if (want(1)) {
  const els = S[1].els;
  const groups = els.filter(e => e.kind === 'group' && e.top);
  const cards = groups.map(g => {
    const kids = els.filter(e => e.chain.includes(g.id));
    const bg = kids.find(k => k.kind === 'shape' && k.w > 250);
    return { g, kids, bg };
  }).sort((a, b) => (Math.round(a.bg.y / 40) - Math.round(b.bg.y / 40)) || (a.bg.x - b.bg.x));
  const released = els.filter(e => e.top && e.text.startsWith('The Game released'));
  const r = [];
  cards.forEach((c, i) => {
    const n = i + 1, k = c.kids;
    const by = t => k.find(x => x.kind === 'shape' && strip(x.text) === t);
    const icon = k.find(x => x.kind === 'image');
    const rel = released.filter(x => Math.abs(x.x - c.bg.x - 11) < 25 && x.y > c.bg.y && x.y - c.bg.y < 100).sort((a, b) => a.y - b.y)[0];
    r.push(R.alt(c.bg.id, `{{i${n}_card}}`), R.alt(icon.id, `{{i${n}_icon}}`)); // groups cannot carry alt text -> card background shape locates the slot
    r.push(...replaceAll(by('The game name'), `{{i${n}_name}}`));
    r.push(...replaceAll(by('Gameplay'), `{{i${n}_gameplay}}`));
    r.push(...replaceAll(by('-'), `{{i${n}_sep}}`));
    r.push(...replaceAll(by('Mech'), `{{i${n}_mech}}`), ...replaceAll(by('Genre'), `{{i${n}_genre}}`), ...replaceAll(by('Theme'), `{{i${n}_theme}}`));
    const like = by('- Like'); r.push({ insertText: { objectId: like.id, insertionIndex: 0, text: `{{i${n}_like}} ` } });
    r.push(...replaceAll(rel, `{{i${n}_released}}`));
  });
  all.push({ slide: 1, r });
}
// slide 3 – Top picks
if (want(2)) {
  const els = S[2].els;
  const icons = els.filter(e => e.kind === 'image').sort((a, b) => (Math.round(a.y / 30) - Math.round(b.y / 30)) || (a.x - b.x));
  const r = icons.map((im, i) => R.alt(im.id, `{{p${i + 1}_icon}}`));
  const boxes = els.filter(e => e.kind === 'shape' && e.text.startsWith('Game')).sort((a, b) => a.x - b.x);
  ['a', 'b'].forEach((c, i) => { r.push(...collapse(boxes[i], `{{p_names_${c}}}`)); r.push({ deleteParagraphBullets: { objectId: boxes[i].id, textRange: { type: 'ALL' } } }); });
  all.push({ slide: 2, r });
}
// slides 4-6 – detail
function detail(si) {
  const els = S[si].els, r = [];
  const titleBox = els.find(e => e.top && e.kind === 'shape' && strip(e.text) === 'Game Name');
  r.push(...replaceAll(titleBox, '{{name}}'));
  const tIcon = els.find(e => e.top && e.kind === 'image' && e.y < 10 && e.x > 120 && e.x < 150); r.push(R.alt(tIcon.id, '{{icon}}'));
  const rel = els.find(e => e.kind === 'shape' && /^\d{4}-\d{2}-\d{2}/.test(e.text)); if (rel) r.push(...replaceAll(rel, '{{release}}'));
  const vid = els.find(e => e.kind === 'video' || (e.kind === 'other' && e.e.video)); if (vid) r.push(R.alt(vid.id, '{{video}}'));
  const core = els.find(e => e.kind === 'shape' && e.text.startsWith('The game is controlled')); r.push(...collapse(core, '{{core}}'));
  const comps = els.filter(e => e.kind === 'group' && e.top && els.some(x => x.chain.includes(e.id) && x.text.startsWith('Control'))).sort((a, b) => a.x - b.x || (a.e.transform.translateX - b.e.transform.translateX));
  comps.sort((a, b) => a.e.transform.translateX - b.e.transform.translateX);
  comps.forEach((g, i) => {
    const n = i + 1, kids = els.filter(x => x.chain.includes(g.id));
    const body = kids.find(x => x.text.startsWith('Control'));
    const head = kids.find(x => x.kind === 'shape' && strip(x.text) === 'Game Name');
    const ic = kids.find(x => x.kind === 'image');
    r.push(...replaceParas(body, [`{{c${n}_control}}`, `{{c${n}_mech}}`, `{{c${n}_board}}`, `{{c${n}_theme}}`]));
    r.push(...replaceAll(head, `{{c${n}_game}}`), R.alt(ic.id, `{{c${n}_icon}}`));
  });
  return r;
}
for (const i of [3,4,5]) if (want(i)) all.push({ slide: i, r: detail(i) });

for (const a of all) {
  try { await slides.presentations.batchUpdate({ presentationId: dstId, requestBody: { requests: a.r } }); console.log(`slide ${a.slide + 1}: ${a.r.length} requests OK`); }
  catch (e) { console.log(`slide ${a.slide + 1} FAILED:`, e.message); }
}
fs.writeFileSync('tokenized-id.txt', dstId);
console.log('DONE', dstId);
