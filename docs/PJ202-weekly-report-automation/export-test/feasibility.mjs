// PJ202 export feasibility test (Slides + Drive API, service account).
// Usage (from the project root, so `googleapis` resolves):
//   SA_KEY=secrets/pj202-sa.json TEMPLATE_ID=<slides id> DRAFT_FOLDER_ID=<drive folder id> \
//     node docs/PJ202-weekly-report-automation/export-test/feasibility.mjs inspect|test
// `inspect` only reads the template and writes template-structure.json.
// `test` copies the template into the Draft folder, exercises every Slides call the export needs,
// writes feasibility-report.json, then trashes the test copy.
import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const { SA_KEY, TEMPLATE_ID, DRAFT_FOLDER_ID } = process.env;
const mode = process.argv[2] || 'inspect';
const outDir = path.dirname(new URL(import.meta.url).pathname);
if (!SA_KEY || !TEMPLATE_ID) { console.error('Set SA_KEY and TEMPLATE_ID (and DRAFT_FOLDER_ID for test)'); process.exit(1); }

const auth = new google.auth.GoogleAuth({
  keyFile: SA_KEY,
  scopes: ['https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/drive'],
});
const slides = google.slides({ version: 'v1', auth });
const drive = google.drive({ version: 'v3', auth });

const text = (el) => (el.shape?.text?.textElements || []).map(t => t.textRun?.content || '').join('').replace(/\s+/g, ' ').trim();
const box = (el) => {
  const s = el.size, t = el.transform || {};
  if (!s) return null;
  const emu = (v) => Math.round(v / 12700); // EMU -> pt
  return { x: emu(t.translateX || 0), y: emu(t.translateY || 0), w: emu(s.width.magnitude * (t.scaleX ?? 1)), h: emu(s.height.magnitude * (t.scaleY ?? 1)) };
};
const walk = (els, depth = 0) => (els || []).flatMap(el => {
  const row = { id: el.objectId, kind: el.shape ? 'shape:' + (el.shape.shapeType || '') : el.image ? 'image' : el.elementGroup ? 'group' : el.table ? 'table' : el.line ? 'line' : 'other', text: text(el).slice(0, 40), box: box(el), depth };
  return [row, ...walk(el.elementGroup?.children, depth + 1)];
});

async function inspect() {
  const { data } = await slides.presentations.get({ presentationId: TEMPLATE_ID });
  const out = data.slides.map((s, i) => ({ index: i + 1, id: s.objectId, elements: walk(s.pageElements) }));
  fs.writeFileSync(path.join(outDir, 'template-structure.json'), JSON.stringify({ title: data.title, size: data.pageSize, slides: out }, null, 1));
  out.forEach(s => console.log(`slide ${s.index} (${s.id}): ${s.elements.length} elements; first texts: ${s.elements.filter(e => e.text).slice(0, 4).map(e => e.text).join(' | ')}`));
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ step: name, ok: true, ms: Date.now() - t0, detail }); console.log('PASS', name, Date.now() - t0 + 'ms'); }
  catch (e) { results.push({ step: name, ok: false, ms: Date.now() - t0, error: e?.errors?.[0]?.message || e.message, code: e.code || e.status }); console.log('FAIL', name, '-', e?.errors?.[0]?.message || e.message); }
}

async function test() {
  if (!DRAFT_FOLDER_ID) throw new Error('DRAFT_FOLDER_ID required for test');
  let copyId;
  await step('1 copy template into Draft folder', async () => {
    const r = await drive.files.copy({ fileId: TEMPLATE_ID, supportsAllDrives: true, fields: 'id,name,owners(emailAddress),parents', requestBody: { name: '[PJ202 TEST] export feasibility ' + new Date().toISOString(), parents: [DRAFT_FOLDER_ID] } });
    copyId = r.data.id; return { id: copyId, owners: r.data.owners?.map(o => o.emailAddress), parents: r.data.parents };
  });
  if (!copyId) return finish();

  let pres;
  const reload = async () => (pres = (await slides.presentations.get({ presentationId: copyId })).data);
  await step('2 read copy (slide + element ids)', async () => { await reload(); return { slides: pres.slides.length }; });
  const insight = pres?.slides?.[1]; // Cover=1, Insight=2 in the current Master Template

  await step('3 duplicate Insight slide x2 and move to end', async () => {
    const r = await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ duplicateObject: { objectId: insight.objectId } }, { duplicateObject: { objectId: insight.objectId } }] } });
    const ids = r.data.replies.map(x => x.duplicateObject.objectId);
    // updateSlidesPosition needs ids in CURRENT presentation order (duplicates land right after the original, newest first)
    await reload();
    const order = pres.slides.map(sl => sl.objectId);
    const sorted = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ updateSlidesPosition: { slideObjectIds: sorted, insertionIndex: pres.slides.length } }] } });
    return { newSlideIds: ids };
  });

  const dup = () => pres.slides[pres.slides.length - 1];
  const firstText = () => walk(dup().pageElements).find(e => e.kind.startsWith('shape') && e.text);

  await step('4 write text into one shape by objectId (deleteText + insertText)', async () => {
    await reload(); const el = firstText();
    await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ deleteText: { objectId: el.id, textRange: { type: 'ALL' } } }, { insertText: { objectId: el.id, insertionIndex: 0, text: 'PJ202 TEST game name' } }] } });
    return { shape: el.id, was: el.text };
  });

  await step('5 replaceAllText scoped to one slide (pageObjectIds)', async () => {
    const r = await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ replaceAllText: { containsText: { text: 'Gameplay', matchCase: true }, replaceText: 'Gameplay (test)', pageObjectIds: [dup().objectId] } }] } });
    return { occurrencesChanged: r.data.replies[0].replaceAllText?.occurrencesChanged };
  });

  await step('6 hyperlink on a text range', async () => {
    await reload(); const el = firstText();
    await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ updateTextStyle: { objectId: el.id, textRange: { type: 'ALL' }, style: { link: { url: 'https://example.com/' } }, fields: 'link' } }] } });
    return { shape: el.id };
  });

  const iconUrls = { apple: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/b4/bf/23/b4bf2304-1dcc-4784-2ddd-8f210882e458/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/150x150bb.jpg', play: 'https://play-lh.googleusercontent.com/687U_VqkmrWZUcjhfCjOO_AnzCWatjSmccRQ4fW5srvCvSJAtgDmz34T8U7-KaORsOJ_UBRNnCMDkqjjOGy2CT4=s150' };
  for (const [k, url] of Object.entries(iconUrls)) {
    await step(`7 createImage from ${k} icon URL`, async () => {
      const r = await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ createImage: { url, elementProperties: { pageObjectId: dup().objectId, size: { width: { magnitude: 50, unit: 'PT' }, height: { magnitude: 50, unit: 'PT' } }, transform: { scaleX: 1, scaleY: 1, translateX: 12700 * 20, translateY: 12700 * 20, unit: 'EMU' } } } }] } });
      return { imageId: r.data.replies[0].createImage.objectId };
    });
  }

  await step('8 createImage with a bad URL (error shape for E27 handling)', async () => {
    try { await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: [{ createImage: { url: 'https://example.invalid/none.png', elementProperties: { pageObjectId: dup().objectId } } }] } }); }
    catch (e) { return { expectedError: e?.errors?.[0]?.message || e.message, code: e.code }; }
    throw new Error('bad URL unexpectedly succeeded');
  });

  await step('9 whole-deck timing: duplicate 3 Insight + 21 Top Pick detail slides in ONE batch', async () => {
    await reload(); const detail = pres.slides[pres.slides.length - 4] && pres.slides.find((s, i) => i >= 5) || insight; // any later slide as the detail stand-in
    const reqs = [];
    for (let i = 0; i < 3; i++) reqs.push({ duplicateObject: { objectId: insight.objectId } });
    for (let i = 0; i < 21; i++) reqs.push({ duplicateObject: { objectId: detail.objectId } });
    const t0 = Date.now(); await slides.presentations.batchUpdate({ presentationId: copyId, requestBody: { requests: reqs } });
    return { requests: reqs.length, ms: Date.now() - t0 };
  });

  await step('10 read-after-write consistency (final slide count)', async () => { await reload(); return { slides: pres.slides.length }; });

  await step('11 trash the test copy', async () => { await drive.files.update({ fileId: copyId, supportsAllDrives: true, requestBody: { trashed: true } }); return {}; });
  finish();
}

function finish() {
  fs.writeFileSync(path.join(outDir, 'feasibility-report.json'), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 1));
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} steps passed. See feasibility-report.json`);
}

try { mode === 'test' ? await test() : await inspect(); } catch (e) { console.error('ABORT', e?.errors?.[0]?.message || e.message); process.exit(1); }
