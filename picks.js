(function(){
'use strict';
const $=id=>document.getElementById(id);
// The creator roster, every account URL, and the creator-to-account mapping live in
// the private Worker. None of it is inlined here, so the published page carries no
// source links, account identifiers, or creator names. The dashboard learns the
// roster only from an authenticated read, after the passphrase unlocks the desk.
let SOURCES=[],ACCOUNTS=[];
function setRoster(list){
  SOURCES=(Array.isArray(list)?list:[]).filter(creator=>creator&&creator.id&&Array.isArray(creator.accounts));
  for(const creator of SOURCES){creator.platform=creator.accounts.map(a=>a.platform).join(' \u00b7 ');creator.url=creator.accounts[0]?.url||'';}
  ACCOUNTS=SOURCES.flatMap(creator=>creator.accounts.map(a=>({...a,sourceId:creator.id})));
  fillSourceSelects();
  window.PitchfordParlay?.setRoster?.(SOURCES);
}
function fillSourceSelects(){for(const id of ['pick-source','picks-check-source']){const host=$(id);host.replaceChildren();for(const creator of SOURCES){const option=el('option','',creator.name);option.value=creator.id;host.append(option);}}}
const MARKETS=['Home run','Moneyline','Spread','Total','Player prop','Other'],labels={pending:'Open',review:'Needs review',win:'Win',loss:'Loss',push:'Push',void:'Void'};
let request,desk={picks:[],checks:[],revisions:[]},loaded=false,busy=false,editing=null,current=null,activeSource='',held=[],agentToken=null;
const source=id=>SOURCES.find(s=>s.id===id),date=s=>s?new Date(s+'T12:00:00').toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}):'Date not confirmed',when=s=>s?new Date(s).toLocaleString():'Not given',signed=n=>(n>0?'+':'')+n.toFixed(2),odds=n=>n===null?'Odds not given':n>0?'+'+n:String(n);
const account=id=>ACCOUNTS.find(a=>a.id===id),accountsFor=id=>(source(id)?.accounts||[]);
// Held in memory for this page only, never in localStorage or sessionStorage, and
// never written anywhere. Without it every request uses the passphrase as before.
const send=body=>request(agentToken?{...body,agentToken}:body);
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function note(text,error=false){$('picks-message').hidden=!text;$('picks-message').textContent=text;$('picks-message').classList.toggle('error',error);}
function syncWarning(text=''){const n=$('picks-sync-warning');n.hidden=!text;n.textContent=text;}
function parseOdds(value){const raw=value.trim();if(!raw)return null;const n=Number(raw);if(!/^[+-]?\d+$/.test(raw)||!Number.isInteger(n)||Math.abs(n)<100||Math.abs(n)>100000)throw new Error('Enter American odds such as +350 or -110, or leave blank if unknown.');return n;}
function stats(items){const active=items.filter(p=>!p.archived&&p.kind!=='lean'),eligible=active.filter(p=>p.capturedBeforeStart&&p.selection.trim()&&p.event.trim()&&p.eventDate&&p.market!=='Other'&&p.odds!==null&&Number.isInteger(p.odds)&&Math.abs(p.odds)>=100&&Math.abs(p.odds)<=100000&&['win','loss','push'].includes(p.status));const profit=eligible.reduce((n,p)=>n+(p.status==='loss'?-1:p.status==='win'?(p.odds>0?p.odds/100:100/Math.abs(p.odds)):0),0);return {open:active.filter(p=>p.status==='pending').length,review:active.filter(p=>p.status==='review').length,wins:active.filter(p=>p.status==='win').length,losses:active.filter(p=>p.status==='loss').length,eligible:eligible.length,profit,roi:eligible.length?profit/eligible.length*100:null};}
function clean(value){return String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(?:to hit|hits?)\b/g,' ').replace(/\b(?:1\+|one or more|anytime)\s*(?:home runs?|hrs?)\b/g,' ').replace(/\b(?:home runs?|hrs?)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim();}
function pickDay(p){return p.eventDate||String(p.postedAt||p.createdAt||'').slice(0,10);}
function identity(p){if(!clean(p.selection))return 'record:'+p.id;const game=(String(p.event||'')+' '+String(p.selection||'')).match(/\bgame\s*([12])\b/i);const market=/home\s*run|\bhr\b/i.test(p.market+' '+p.selection)?'home run':clean(p.market);return [p.sport,market,clean(p.selection),pickDay(p),game?game[1]:''].join('|');}
function groupPicks(items){const groups=new Map();for(const p of items){const key=identity(p),group=groups.get(key)||{key,picks:[],sourceIds:[],ownerId:''};group.picks.push(p);if(!group.sourceIds.includes(p.sourceId))group.sourceIds.push(p.sourceId);groups.set(key,group);}for(const group of groups.values()){group.sourceIds.sort((a,b)=>SOURCES.findIndex(s=>s.id===a)-SOURCES.findIndex(s=>s.id===b));group.ownerId=group.sourceIds[0]||group.picks[0].sourceId;group.picks.sort((a,b)=>{const sourceOrder=SOURCES.findIndex(s=>s.id===a.sourceId)-SOURCES.findIndex(s=>s.id===b.sourceId);return sourceOrder||String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt));});}return [...groups.values()];}

// ---- verification before a pick is shown in the clean list -------------------
// This checks the record against the evidence already stored with it. It does not
// open the live account; live rechecks are not enabled.
const HEDGE=/\b(?:lean|leans|leaning|maybe|might|thinking|watching|monitoring|monitor|considering|possibly|possible|sprinkle|flier|if\s)/i;
function tokens(text){return clean(text).split(' ').filter(word=>word.length>2);}
function evidenceBacked(p,loose){const selection=clean(p.selection);if(!selection)return false;const evidence=clean(p.originalText);if(!evidence)return false;if(evidence.includes(selection))return true;const have=new Set(tokens(p.originalText)),need=tokens(p.selection);if(!need.length)return false;const hits=need.filter(word=>have.has(word)).length;return loose?hits/need.length>=0.5:hits===need.length;}
function verify(p,loose=false){
  if(!source(p.sourceId))return{ok:false,reason:'Source is not one of the configured creators.'};
  if(p.accountId&&!accountsFor(p.sourceId).some(a=>a.id===p.accountId))return{ok:false,reason:'Account does not belong to this creator.'};
  if(p.archived)return{ok:false,reason:'Archived.'};
  if(p.status==='review')return{ok:false,reason:'Still marked needs review.'};
  if(p.status==='void')return{ok:false,reason:'Voided.'};
  if(!p.capturedBeforeStart)return{ok:false,reason:'Not confirmed captured before the event started.'};
  for(const [key,label] of [['selection','the exact selection'],['event','the event'],['eventDate','the event date'],['originalText','the original evidence']])if(!String(p[key]||'').trim())return{ok:false,reason:'Missing '+label+'.'};
  if(!/^https:\/\//.test(String(p.sourceUrl||'')))return{ok:false,reason:'No https link to the original post.'};
  if(HEDGE.test(p.selection))return{ok:false,reason:'Wording is a lean or a watch, not a stated pick.'};
  if(/\?\s*$/.test(String(p.selection).trim()))return{ok:false,reason:'Selection is phrased as a question.'};
  if(!evidenceBacked(p,loose))return{ok:false,unclear:true,reason:'Selection wording is not supported by the stored original evidence.'};
  return{ok:true};
}
function confirmPick(p){const first=verify(p,false);if(first.ok)return{ok:true,rechecked:false};if(!first.unclear)return{...first,rechecked:false};const second=verify(p,true);return second.ok?{ok:true,rechecked:true}:{...second,rechecked:true};}
function plainLine(p){const selection=String(p.selection||'').trim().replace(/\s+/g,' '),lower=selection.toLowerCase(),event=String(p.event||'').trim().replace(/\s+/g,' ');
  if(p.market==='Moneyline')return /moneyline|\bml\b/.test(lower)?selection:selection+' moneyline';
  if(p.market==='Total')return /^(?:over|under|o|u)\b/.test(lower)&&event?event+' '+selection:selection;
  if(p.market==='Home run'&&!/home\s*run|\bhr\b/.test(lower))return selection+' home run';
  return selection;}
function cleanList(items){const lines=[],withheld=[],seen=new Set();
  for(const group of groupPicks(items.filter(p=>!p.archived&&p.kind!=='lean'))){
    let chosen=null,outcome=null;
    for(const p of group.picks){const result=confirmPick(p);if(result.ok){chosen=p;outcome=result;break;}if(!outcome)outcome=result;}
    if(!chosen){withheld.push({id:group.picks[0].id,creator:source(group.ownerId)?.name||group.ownerId,reason:outcome?.reason||'Not verified.',rechecked:!!outcome?.rechecked});continue;}
    const text=plainLine(chosen),key=text.toLowerCase();
    if(seen.has(key))continue;
    seen.add(key);lines.push({id:chosen.id,text,rechecked:outcome.rechecked});}
  return {lines,withheld};}
function renderClean(){const {lines,withheld}=cleanList(desk.picks);held=withheld;const host=$('picks-clean-list');host.replaceChildren();
  if(!lines.length)host.append(el('li','','- No eligible picks right now.'));
  else for(const line of lines)host.append(el('li','','- '+line.text));
  $('picks-clean-held').textContent=withheld.length?withheld.length+(withheld.length===1?' pick is':' picks are')+' held back. The reason for each stays in the private record.':'';
  renderLeans();}
function leanList(items){const lines=[],seen=new Set();
  for(const group of groupPicks(items.filter(p=>!p.archived&&p.kind==='lean'))){
    const p=group.picks[0],text=plainLine(p),key=text.toLowerCase();
    if(!text||seen.has(key))continue;
    seen.add(key);lines.push({id:p.id,text,creator:source(group.ownerId)?.name||group.ownerId});}
  return lines;}
function renderLeans(){const lines=leanList(desk.picks),host=$('picks-leans-list');host.replaceChildren();
  if(!lines.length)host.append(el('li','','- No leans recorded.'));
  else for(const line of lines)host.append(el('li','','- '+line.text));}

// ---- private reel intake ----------------------------------------------------
// Transcription runtime is pluggable. Nothing here downloads a model or installs
// software; an adapter that is not present reports itself unavailable and the run
// stops with a named missing dependency.
const TRANSCRIBERS=[
 {id:'provided',label:'Transcript supplied by the caller',available:()=>true,
  transcribe:async input=>{const text=String(input.transcript||'').trim();if(!text)throw new Error('No transcript was supplied.');return{text,engine:String(input.engine||'provided').trim()||'provided'};}},
 {id:'local-whisper',label:'Local Whisper runtime',available:()=>false,
  transcribe:async()=>{throw new Error('No local transcription runtime is installed. Install one on this machine and wire it to the local-whisper adapter; nothing is downloaded automatically.');}}];
const transcriber=id=>TRANSCRIBERS.find(t=>t.id===id);
// Spoken cues only. Order matters: a qualified phrase makes the selection a lean
// even when firm-sounding words appear in the same sentence.
const LEAN_CUE=/\b(?:lean(?:ing|s)?(?:\s+(?:toward|towards|to))?|would\s+have\s+to\s+lean|i'?d\s+lean|maybe|probably|might|i'?d\s+say|i\s+guess|slight(?:ly)?|kind\s+of\s+like|if\s+i\s+had\s+to)\b/i;
const FIRM_CUE=/\b(?:give\s+me|gimme|i\s+love|i'?m\s+(?:on|taking|riding|playing)|lock(?:ed)?\s+it\s+in|lock\s+of\s+the\s+day|take\s+the|i\s+like\s+the|hammer(?:ing)?|my\s+pick\s+is|we'?re\s+taking|the\s+play\s+is|bet\s+the)\b/i;
// Sentences that are reading someone else's words are not the creator's pick.
const RELAYED=/\b(?:comments?|commenters?|someone|somebody|you\s+guys|dm(?:ed|s)?|chat\s+said|caption\s+says|he\s+said|she\s+said|they\s+said)\b/i;
const FILLER=/^(?:and|so|ok(?:ay)?|alright|now|then|uh|um|look|listen|honestly|i\s+think|i\s+mean|but|also|next)\b[\s,]*/i;
function sentences(text){return String(text||'').split(/(?<=[.!?])\s+|\n+/).map(line=>line.trim()).filter(Boolean);}
function trimSelection(text){let out=String(text||'').replace(/^[\s,.:;–—-]+/,'').replace(/[\s,.:;!?]+$/,'');for(let i=0;i<3;i++){const next=out.replace(FILLER,'');if(next===out)break;out=next;}return out.replace(/\s+/g,' ').trim();}
function extractFromTranscript(text){
  const candidates=[],ignored=[];
  for(const sentence of sentences(text)){
    if(RELAYED.test(sentence)){ignored.push({sentence,reason:'Relays someone else’s words rather than the creator’s own pick.'});continue;}
    const lean=sentence.match(LEAN_CUE),firm=sentence.match(FIRM_CUE);
    if(!lean&&!firm){ignored.push({sentence,reason:'No stated pick or lean in this sentence.'});continue;}
    const cue=lean||firm,kind=lean?'lean':'firm';
    const selection=trimSelection(sentence.slice(cue.index+cue[0].length));
    if(!selection){ignored.push({sentence,reason:'Cue phrase with nothing stated after it.'});continue;}
    candidates.push({kind,cue:cue[0].toLowerCase(),selection,sentence});
  }
  return {candidates,ignored};
}
// The reopened post decides the class: the captured wording is read with the same
// cues used for reels. Preston never picks firm or lean by hand, and neither does
// an agent; both only supply the evidence and the proof that the link was reopened.
function classify(text){const {candidates,ignored}=extractFromTranscript(text);
  if(candidates.some(c=>c.kind==='firm'))return{outcome:'firm',reason:''};
  if(candidates.some(c=>c.kind==='lean'))return{outcome:'lean',reason:''};
  return{outcome:'unclear',reason:ignored[0]?.reason||'No stated pick or lean in the captured wording.'};}
const CAPTURE_LABEL={firm:'Firm pick',lean:'Lean',unclear:'Unclear \u2014 saves for review'};
let recheck=null;
function showClass(){const derived=classify(field('originalText').value);field('kind').value=derived.outcome==='lean'?'lean':'firm';$('pick-class-state').textContent=CAPTURE_LABEL[derived.outcome]+(derived.outcome==='unclear'?': '+derived.reason:'');return derived;}
function showRecheck(){const url=field('sourceUrl').value.trim();
  $('pick-recheck-state').textContent=recheck&&recheck.checkedUrl===url?'Reopened '+when(recheck.checkedAt):'Not reopened yet. Required before saving.';
  $('pick-recheck').disabled=!/^https:\/\//.test(url);}
function reopenSource(){const url=field('sourceUrl').value.trim();
  if(!/^https:\/\//.test(url)){$('pick-form-error').textContent='Add the https source link first.';return;}
  window.open(url,'_blank','noopener,noreferrer');
  recheck={checkedUrl:url,checkedAt:new Date().toISOString()};
  showRecheck();}
function state(value){busy=value;document.querySelectorAll('#view-picks button,#pick-dialog button,#pick-detail button').forEach(b=>b.disabled=value);}
async function load(){if(busy)return false;state(true);note('');try{const data=await send({action:'read'});if(!data)return false;desk=data;setRoster(data.roster);loaded=true;$('picks-content').hidden=false;$('picks-locked').hidden=true;syncWarning();render();return true;}catch(e){note(e.message,true);return false;}finally{state(false);}}
async function change(body){
  if(busy)throw new Error('Wait for the current save to finish.');
  state(true);
  try{
    const result=await send(body);
    if(!result)throw new Error('Unlock your picks to continue.');
    if(result.pick){const i=desk.picks.findIndex(p=>p.id===result.pick.id);if(i<0)desk.picks.unshift(result.pick);else desk.picks[i]=result.pick;}
    if(result.check)desk.checks.unshift(result.check);
    let refreshWarning='';
    try{
      const data=await send({action:'read'});
      if(!data)throw new Error('Sign-in was canceled.');
      desk=data;setRoster(data.roster);loaded=true;$('picks-content').hidden=false;$('picks-locked').hidden=true;syncWarning();
    }catch(e){refreshWarning='Saved successfully, but the full list could not refresh. Use Refresh before reviewing totals or history.';syncWarning(refreshWarning);}
    if(loaded)render();
    return refreshWarning?{...result,refreshWarning}:result;
  }finally{state(false);}
}
function renderTabs(groups){const host=$('picks-source-tabs');host.replaceChildren();for(const s of SOURCES){const count=groups.filter(g=>g.ownerId===s.id).length,button=el('button','picks-source-tab',s.name+' ('+count+')');button.type='button';button.dataset.source=s.id;button.setAttribute('role','tab');button.setAttribute('aria-selected',String(activeSource===s.id));button.addEventListener('click',()=>{activeSource=s.id;renderList();});host.append(button);}}
function render(){const sum=stats(desk.picks),unique=groupPicks(desk.picks.filter(p=>!p.archived)),overlaps=unique.filter(g=>g.sourceIds.length>1).length,host=$('picks-stats');host.replaceChildren();for(const [name,value]of[['UNIQUE PICKS',unique.length],['OVERLAPS',overlaps],['SOURCE W–L',sum.wins+sum.losses?sum.wins+'–'+sum.losses:'—'],['SOURCE NET RETURN',sum.eligible?signed(sum.profit)+'u':'—']]){const box=el('div','picks-stat');box.append(el('span','',name),el('strong','',String(value)));host.append(box);}renderClean();renderList();const records=$('picks-records'),sources=$('picks-sources');records.replaceChildren();sources.replaceChildren();SOURCES.forEach(s=>{const st=stats(desk.picks.filter(p=>p.sourceId===s.id)),tr=el('tr');for(const text of [s.name,st.wins+'–'+st.losses,String(st.eligible),st.eligible?signed(st.profit)+'u':'—',st.roi===null?'—':signed(st.roi)+'%'])tr.append(el('td','',text));records.append(tr);const check=desk.checks.find(c=>c.sourceId===s.id),box=el('div','picks-source');box.append(el('strong','',s.name));for(const acc of s.accounts){const a=el('a','',acc.platform+' ↗');a.href=acc.url;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}box.append(el('small','',check?.status||'No check recorded'));if(check)box.append(el('p','',check.note),el('p','',when(check.checkedAt)));sources.append(box);});}
function renderList(){const host=$('picks-list'),sport=$('picks-sport').value,view=$('picks-view').value;host.replaceChildren();const items=desk.picks.filter(p=>(sport==='all'||p.sport===sport)&&(view==='archived'?p.archived:!p.archived&&(view==='open'?['pending','review'].includes(p.status):view==='review'?p.status==='review':view==='settled'?['win','loss','push','void'].includes(p.status):true))),groups=groupPicks(items);if(groups.length&&!groups.some(g=>g.ownerId===activeSource))activeSource=groups[0].ownerId;renderTabs(groups);const visible=groups.filter(g=>g.ownerId===activeSource);if(!visible.length){host.append(el('div','picks-empty','No unique picks assigned to this source in the selected view.'));return;}visible.forEach(group=>{const p=group.picks[0],card=el('article','pick-card'),top=el('div','pick-card-top'),bottom=el('div','pick-card-bottom'),evidence=el('div','pick-sources');card.setAttribute('role','button');card.setAttribute('tabindex','0');card.addEventListener('click',()=>detail(p));card.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();detail(p);}});const statuses=[...new Set(group.picks.map(item=>item.archived?'archived':item.status))],status=statuses.length===1?statuses[0]:'review';top.append(el('span','',source(group.ownerId)?.name||group.ownerId),el('span','pick-state '+status,statuses.length===1?(status==='archived'?'Archived':labels[status]):'Mixed status'));const quoted=[...new Set(group.picks.map(item=>odds(item.odds)))];bottom.append(el('span','',quoted.join(' · ')),el('span','',group.picks.every(item=>item.capturedBeforeStart)?'Captured before start':'Includes timing unconfirmed'));for(const sourceId of group.sourceIds){const record=group.picks.find(item=>item.sourceId===sourceId),button=el('button','pick-source-credit',(source(sourceId)?.name||sourceId)+' evidence');button.type='button';button.addEventListener('click',event=>{event.stopPropagation?.();detail(record);});evidence.append(button);}card.append(top,el('h3','',p.selection||'Selection needs review'),el('p','',p.sport+' · '+p.market+' · '+(p.event||'Event not confirmed')+' · '+date(p.eventDate)),bottom,evidence);if(group.sourceIds.length>1)card.classList.toggle('overlap',true);host.append(card);});}
function field(name){return $('pick-form').elements.namedItem(name);}
function fillAccounts(sourceId,selected='',historical=false){const host=$('pick-account'),accounts=accountsFor(sourceId);host.replaceChildren();
  if(historical&&!selected){const blank=el('option','','Account not recorded');blank.value='';host.append(blank);}
  else if(!historical&&accounts.length>1){const blank=el('option','','Select the account');blank.value='';host.append(blank);}
  for(const acc of accounts){const option=el('option','',acc.platform);option.value=acc.id;host.append(option);}
  host.value=accounts.some(acc=>acc.id===selected)?selected:(!historical&&accounts.length===1?accounts[0].id:'');host.required=!historical;}
function start(p=null){if(!SOURCES.length){note('Unlock your picks before capturing a new one.',true);return;}editing=p;$('pick-form').reset();$('pick-form-error').textContent='';$('pick-form-title').textContent=p?'Review or correct':'Capture a pick';$('pick-form-note').textContent=p?'Original evidence is preserved. Corrections reopen the result.':'Keep the original words. Leave uncertain details blank.';const value=p||{sourceId:SOURCES[0].id,sport:'MLB',market:'Home run',odds:null,postedAt:''};for(const key of ['sourceId','sport','market','selection','event','eventDate','sourceUrl','originalText'])field(key).value=value[key]||'';field('kind').value=value.kind||'firm';field('kind').disabled=true;recheck=null;$('pick-recheck-row').hidden=!!p;if(!p){showClass();showRecheck();}else $('pick-class-state').textContent=value.kind==='lean'?CAPTURE_LABEL.lean:CAPTURE_LABEL.firm;fillAccounts(value.sourceId,value.accountId||'',!!p);field('accountId').disabled=!!p;field('odds').value=value.odds===null?'':String(value.odds);field('postedAt').value=value.postedAt?new Date(Date.parse(value.postedAt)-new Date(value.postedAt).getTimezoneOffset()*60000).toISOString().slice(0,16):'';field('capturedBeforeStart').checked=!!value.capturedBeforeStart;field('sourceId').disabled=!!p;field('originalText').readOnly=!!p;field('sourceUrl').readOnly=!!p;$('pick-reason-field').hidden=!p;field('reason').required=!!p;$('pick-dialog').showModal();}
function detail(p){current=p;$('pick-detail-title').textContent=p.selection||'Review source entry';$('pick-detail-meta').textContent=(source(p.sourceId)?.name||p.sourceId)+(p.accountId?' · '+(account(p.accountId)?.platform||p.accountId):'')+' · '+p.sport+' · '+p.market+' · '+date(p.eventDate)+' · '+odds(p.odds);$('pick-evidence').textContent=p.originalText;$('pick-detail-kind').textContent=p.kind==='lean'?'Lean · qualified wording; not counted as a confirmed pick':'Firm pick';$('pick-detail-reel').textContent=p.transcriptId?'From a reel transcript held in your private record.':'';const a=$('pick-original-link');a.hidden=!p.sourceUrl;if(p.sourceUrl)a.href=p.sourceUrl;$('pick-evidence-date').textContent='Posted: '+when(p.postedAt)+' · Captured: '+when(p.createdAt);$('pick-archive').textContent=p.archived?'Restore':'Archive';$('pick-result-form').hidden=p.archived;$('pick-outcome').value=p.status;$('pick-result-note').value=p.resultEvidence||'';$('pick-result-link').value=p.resultUrl||'';$('pick-result-error').textContent='';const history=$('pick-history');history.replaceChildren(el('p','','Created '+when(p.createdAt)+' · Version '+p.revision));desk.revisions.filter(r=>r.pickId===p.id).forEach(r=>{const d=el('details');d.append(el('summary','',r.reason+' · '+when(r.changedAt)),el('pre','',r.snapshot));history.append(d);});$('pick-detail').showModal();}
function closeDialog(id){$(id).close();$('picks-refresh').focus?.();}
function init(api){request=api;for(const m of MARKETS){const option=el('option','',m);option.value=m;$('pick-market').append(option);}field('sourceId').addEventListener('change',()=>fillAccounts(field('sourceId').value));$('picks-unlock').addEventListener('click',load);$('picks-refresh').addEventListener('click',load);$('picks-add').addEventListener('click',()=>start());for(const id of ['picks-sport','picks-view'])$(id).addEventListener('change',renderList);document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{if(!busy)closeDialog(b.dataset.close);}));for(const id of ['pick-dialog','pick-detail'])$(id).addEventListener('cancel',event=>{if(busy)event.preventDefault();});
$('picks-check-form').addEventListener('submit',async event=>{event.preventDefault();const error=$('picks-check-error'),sourceId=$('picks-check-source').value,status=$('picks-check-status').value,checkNote=$('picks-check-note').value.trim();error.textContent='';if(!source(sourceId)||!checkNote){error.textContent='Choose a source and describe what you checked or what blocked access.';return;}try{await change({action:'check',sourceId,status,note:checkNote});$('picks-check-note').value='';note('Source check saved.');}catch(e){error.textContent=e.message;}});
field('sport').addEventListener('change',()=>{if(field('sport').value==='NFL'&&field('market').value==='Home run')field('market').value='Player prop';});
field('originalText').addEventListener('input',()=>{if(!editing)showClass();});
field('sourceUrl').addEventListener('input',()=>{if(!editing)showRecheck();});
$('pick-recheck').addEventListener('click',()=>{if(!editing)reopenSource();});
$('pick-form').addEventListener('submit',async event=>{event.preventDefault();$('pick-form-error').textContent='';const p={};for(const key of ['sourceId','accountId','kind','sport','market','selection','event','eventDate','sourceUrl','originalText'])p[key]=field(key).value.trim();try{p.odds=parseOdds(field('odds').value);}catch(e){$('pick-form-error').textContent=e.message;return;}if(!editing&&!p.accountId&&accountsFor(p.sourceId).length>1){$('pick-form-error').textContent='Choose which of this creator’s accounts this pick came from.';return;}
  let verification=null;
  if(!editing){
    if(!recheck||recheck.checkedUrl!==p.sourceUrl){$('pick-form-error').textContent='Reopen this pick\u2019s source link once before saving it.';return;}
    const derived=showClass();
    verification={...derived,...recheck};
  }p.postedAt=field('postedAt').value?new Date(field('postedAt').value).toISOString():'';p.capturedBeforeStart=field('capturedBeforeStart').checked;try{await change(editing?{action:'edit',id:editing.id,revision:editing.revision,pick:p,reason:field('reason').value}:{action:'save',pick:p,verification});closeDialog('pick-dialog');note(editing?'Correction saved; previous evidence is kept in history.':'Source entry saved as '+CAPTURE_LABEL[verification.outcome].toLowerCase()+'.');}catch(e){$('pick-form-error').textContent=e.message;}});
$('pick-edit').addEventListener('click',()=>{$('pick-detail').close();start(current);});$('pick-archive').addEventListener('click',async()=>{try{await change({action:'archive',id:current.id,revision:current.revision,archived:!current.archived});closeDialog('pick-detail');note(current.archived?'Pick restored.':'Pick archived. It can be restored from the Archived view.');}catch(e){$('pick-result-error').textContent=e.message;note(e.message,true);}});
$('pick-result-form').addEventListener('submit',async event=>{event.preventDefault();try{await change({action:'settle',id:current.id,revision:current.revision,status:$('pick-outcome').value,resultEvidence:$('pick-result-note').value,resultUrl:$('pick-result-link').value});closeDialog('pick-detail');note('Result saved.');}catch(e){$('pick-result-error').textContent=e.message;}});
const mc=document.modelContext||navigator.modelContext;if(mc){const add=(name,description,inputSchema,execute,readOnly=false)=>{Promise.resolve(mc.registerTool({name,description,inputSchema,annotations:{readOnlyHint:readOnly},execute})).catch(()=>{});};const prop={type:'object',properties:{}};add('dashboard_picks_read','Read private picks and source checks from the integrated Sports Picks dashboard tab. Requires existing dashboard passphrase sign-in.',prop,async()=>{if(!await load())throw new Error('Could not read fresh picks. Unlock Sports Picks or check the connection and try again.');return JSON.stringify({sources:SOURCES,...desk,cleanList:cleanList(desk.picks).lines.map(line=>line.text),leans:leanList(desk.picks),heldBack:held});},true);const properties={sourceId:{type:'string'},sport:{type:'string',enum:['MLB','NFL']},market:{type:'string',enum:MARKETS},selection:{type:'string'},event:{type:'string'},eventDate:{type:'string'},odds:{type:['integer','null']},postedAt:{type:'string'},sourceUrl:{type:'string'},originalText:{type:'string'},capturedBeforeStart:{type:'boolean'}};add('dashboard_reel_transcribers','List the transcription adapters wired to this dashboard and whether each is available on this machine. Read only; installs and downloads nothing.',prop,async()=>JSON.stringify(TRANSCRIBERS.map(t=>({id:t.id,label:t.label,available:t.available()}))),true);
add('dashboard_reel_intake','Store one reel transcript as private evidence and return the selections the creator actually spoke. Audio transcripts only: captions and viewer comments are never a source. Supply transcript text with transcriber "provided", or name an installed adapter. Saves no pick; nothing is published. Places no bet.',{type:'object',properties:{transcriber:{type:'string',enum:TRANSCRIBERS.map(t=>t.id)},sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'},transcript:{type:'string'},engine:{type:'string'},transcribedAt:{type:'string'}},required:['transcriber','sourceId','accountId','sourceUrl'],additionalProperties:false},async input=>{
  const adapter=transcriber(input.transcriber);
  if(!adapter)throw new Error('Unknown transcriber.');
  if(!adapter.available())throw new Error(adapter.label+' is not available. '+(await adapter.transcribe(input).catch(e=>e.message)));
  const {text,engine}=await adapter.transcribe(input);
  const result=await change({action:'transcript',transcript:{sourceId:input.sourceId,accountId:input.accountId,sourceUrl:input.sourceUrl,medium:'audio',engine,transcript:text,transcribedAt:input.transcribedAt||new Date().toISOString()}});
  return JSON.stringify({transcriptId:result.transcript.id,reused:!!result.reused,...extractFromTranscript(text)});});
add('dashboard_picks_capture','Save one original source pick or unresolved caption to the private dashboard. Never invent odds, selection, event, or date. Unknown fields empty, odds null. accountId names which of the creator’s verified accounts it came from; leave it empty when unknown. Reopen the pick’s exact source link once immediately before calling this, then pass that same link as checkedUrl and the time as checkedAt; a save without them is refused. Firm, lean, or unclear is derived from the captured wording, never chosen by you or by Preston. transcriptId ties the pick to a stored reel transcript; the selection must appear in that transcript. Historical/uncertain timing must use capturedBeforeStart=false. Places no bet.',{type:'object',properties:{...properties,accountId:{type:'string'},transcriptId:{type:'string'},checkedUrl:{type:'string'},checkedAt:{type:'string'}},required:[...Object.keys(properties),'checkedUrl','checkedAt'],additionalProperties:false},async p=>{const {checkedUrl,checkedAt,...pick}=p;
  const derived=classify(pick.originalText||'');
  return JSON.stringify(await change({action:'save',pick,verification:{...derived,checkedUrl:checkedUrl||'',checkedAt:checkedAt||''}}));});add('dashboard_picks_source_check','Record an actual check of a configured source, including extraction or access blockers. Creator and account ids come from dashboard_picks_read; the page holds no roster until it is unlocked.',{type:'object',properties:{sourceId:properties.sourceId,status:{type:'string',enum:['Checked','No new posts','Sign-in needed','Access blocked','Needs review']},note:{type:'string'}},required:['sourceId','status','note']},async p=>JSON.stringify(await change({action:'check',...p})));add('dashboard_picks_automation_token','Authenticate this page with the scheduled task’s automation token instead of Preston’s dashboard passphrase, then load the desk. The token is kept in memory for this page only and is never stored. It permits reading, capturing new picks, recording source checks and storing reel evidence; corrections, results, archiving and imports stay passphrase-only. Never print, log, or repeat the token.',{type:'object',properties:{token:{type:'string'}},required:['token'],additionalProperties:false},async p=>{const supplied=String(p.token||'').trim();if(!supplied)throw new Error('No automation token was supplied.');agentToken=supplied;if(!await load()){agentToken=null;throw new Error('The automation token was not accepted. The desk stays locked.');}return JSON.stringify({authenticated:'automation token',creators:SOURCES.length,picks:desk.picks.length});});
add('dashboard_picks_import','Import Preston’s existing Picks Desk records into his integrated private dashboard, preserving original IDs, timestamps, and history. Only use for the user-authorized migration; never fabricate imported records.',{type:'object',properties:{desk:{type:'object',properties:{picks:{type:'array',items:{type:'object'}},checks:{type:'array',items:{type:'object'}},revisions:{type:'array',items:{type:'object'}}},required:['picks','checks','revisions']}},required:['desk']},async p=>JSON.stringify(await change({action:'import',desk:p.desk})));}
}
window.PitchfordPicks={init,open:()=>{if(loaded)render();},read:async()=>{if(!await load())throw new Error('Unlock Sports Picks or check the connection and try again.');return desk;},stats,groupPicks,cleanList,leanList,verify:confirmPick,plainLine,classify,sources:()=>SOURCES,extractFromTranscript,transcribers:TRANSCRIBERS};
})();
