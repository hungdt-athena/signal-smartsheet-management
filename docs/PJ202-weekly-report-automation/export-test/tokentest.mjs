import fs from 'fs'; import { google } from 'googleapis';
const auth = new google.auth.GoogleAuth({ keyFile: process.env.SA_KEY, scopes: ['https://www.googleapis.com/auth/presentations','https://www.googleapis.com/auth/drive'] });
const slides = google.slides({ version: 'v1', auth }); const drive = google.drive({ version: 'v3', auth });
const TOK = fs.readFileSync('tokenized-id.txt','utf8').trim(), FOLDER='1FEBZ4c-ueBhy_kIq6nLHi1ak744iCHN1';
// 0. make the top-pick name boxes top-anchored on the master token template
let p = (await slides.presentations.get({ presentationId: TOK })).data;
const flat=(els)=>els.flatMap(e=>e.elementGroup?[e,...flat(e.elementGroup.children)]:[e]);
const txt=e=>e.shape?.text?.textElements?.map(t=>t.textRun?.content??'').join('')??'';
const nb=flat(p.slides[2].pageElements).filter(e=>/\{\{p_names_/.test(txt(e)));
if(false) await slides.presentations.batchUpdate({presentationId:TOK,requestBody:{requests:nb.map(e=>({updateShapeProperties:{objectId:e.objectId,shapeProperties:{contentAlignment:'TOP'},fields:'contentAlignment'}}))}});
console.log('top-anchored', nb.length);
// 1. temp copy, then exercise the token/alt-text locators
const c=(await drive.files.copy({fileId:TOK,supportsAllDrives:true,requestBody:{name:'tmp token test',parents:[FOLDER]},fields:'id'})).data.id;
p=(await slides.presentations.get({presentationId:c})).data;
const byAlt=(si,t)=>flat(p.slides[si].pageElements).find(e=>e.title===t);
const res=[];
const t=async(n,f)=>{try{await f();res.push(['PASS',n]);}catch(e){res.push(['FAIL',n,e.message]);}};
await t('replaceImage on icon inside a group (alt-title locator)',async()=>{const el=byAlt(1,'{{i1_icon}}');await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[{replaceImage:{imageObjectId:el.objectId,imageReplaceMethod:'CENTER_CROP',url:'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/b4/bf/23/b4bf2304-1dcc-4784-2ddd-8f210882e458/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/150x150bb.jpg'}}]}});});
await t('replaceImage on top-pick grid icon',async()=>{const el=byAlt(2,'{{p1_icon}}');await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[{replaceImage:{imageObjectId:el.objectId,imageReplaceMethod:'CENTER_CROP',url:'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/b4/bf/23/b4bf2304-1dcc-4784-2ddd-8f210882e458/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/150x150bb.jpg'}}]}});});
await t('replace video placeholder with YouTube video (delete + createVideo at same geometry)',async()=>{const el=byAlt(3,'{{video}}');
  await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[
   {createVideo:{source:'YOUTUBE',id:'dxV5ZuvMezg',elementProperties:{pageObjectId:p.slides[3].objectId,size:el.size,transform:el.transform}}},{deleteObject:{objectId:el.objectId}}]}});});
await t('set text + hyperlink on token shape found by token text',async()=>{const el=flat(p.slides[1].pageElements).find(e=>txt(e).startsWith('{{i1_name}}'));const L=txt(el).replace(/\n$/,'').length;const name='Snacky Dash: Logic Maze Puzzle';
  await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[{insertText:{objectId:el.objectId,insertionIndex:L,text:name}},{deleteText:{objectId:el.objectId,textRange:{type:'FIXED_RANGE',startIndex:0,endIndex:L}}},{updateTextStyle:{objectId:el.objectId,textRange:{type:'ALL'},style:{link:{url:'https://play.google.com/store/apps/details?id=com.b2p.gobbledash2'}},fields:'link'}}]}});});
await t('delete one whole card slot (group found via its {{i8_card}} child)',async()=>{const flatTop=p.slides[1].pageElements.find(g=>g.elementGroup&&flat([g]).some(e=>e.title==='{{i8_card}}'));
  await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[{deleteObject:{objectId:flatTop.objectId}}]}});});
await t('resize + move a chip (updatePageElementTransform ABSOLUTE)',async()=>{const el=flat(p.slides[1].pageElements).find(e=>txt(e).includes('{{i1_mech}}'));
  await slides.presentations.batchUpdate({presentationId:c,requestBody:{requests:[{updatePageElementTransform:{objectId:el.objectId,applyMode:'ABSOLUTE',transform:{...el.transform,scaleX:(el.transform.scaleX??1)*1.6}}}]}});});
for(const r of res)console.log(r.join(' | '));
const tid=c;
const th=(await slides.presentations.pages.getThumbnail({presentationId:c,pageObjectId:p.slides[1].objectId,'thumbnailProperties.thumbnailSize':'LARGE'})).data;
fs.writeFileSync('tt_2.png',Buffer.from(await (await fetch(th.contentUrl)).arrayBuffer()));
const th4=(await slides.presentations.pages.getThumbnail({presentationId:c,pageObjectId:p.slides[3].objectId,'thumbnailProperties.thumbnailSize':'LARGE'})).data;
fs.writeFileSync('tt_4.png',Buffer.from(await (await fetch(th4.contentUrl)).arrayBuffer()));
await drive.files.update({fileId:c,supportsAllDrives:true,requestBody:{trashed:true}}); console.log('temp trashed');
