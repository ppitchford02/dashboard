#!/usr/bin/env node
/*
 * Local, token-scoped MCP bridge for the private Sports Picks Worker.
 * It never returns, logs, or accepts the automation token as a tool argument.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const freshness = require('./picks-freshness.js');
const runState = require('./picks-run-state.js');
const { formatRunReport, boundedReceiptNote } = require('./picks-run-report.js');
const { evidenceLadderInstruction } = require('./picks-evidence-ladder.js');

const WORKER_URL = process.env.PICKS_WORKER_URL || 'https://pitchford-os-ask.ppitchford02.workers.dev/picks';
const TOKEN_FILE = process.env.PICKS_TOKEN_FILE || path.join(process.env.HOME || '', 'dashboard', 'picks-agent-token.txt');
const ROSTER_FILE = process.env.PICKS_ROSTER_FILE || path.join(__dirname, 'picks-roster.json');

const tools = [
  {name:'sports_picks_checkpoint',description:'Call before browser work with startedAt, then immediately after EACH account inventory. Saves exact links locally before freshness; does not interpret or mark covered. Read activeRun.inventory to resume only unfinished accounts. Holds a bounded idle-sleep assertion on Mac during this pass.',inputSchema:{type:'object',properties:{startedAt:{type:'string'},sourceId:{type:'string'},accountId:{type:'string'},status:{type:'string',enum:['checked','blocked']},reason:{type:'string'},candidates:{type:'array',items:{type:'object',properties:{sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'},postedAt:{type:'string'},contentHash:{type:'string'}},required:['sourceId','accountId','sourceUrl'],additionalProperties:true}}},required:['startedAt'],additionalProperties:false}},
  { name:'sports_picks_resolve_post', description:'Record the actual evidence result for ONE released post. Read the full graphic/legend, audio or related creator clarification before giving up. resolved means EVERY recommendation was saved or already exists; excluded needs observed reason (non-pick, settled event or outside NFL/MLB); unresolved stays pending. Never resolve from a listing caption or merely because one pick was saved.', inputSchema:{type:'object',properties:{startedAt:{type:'string'},sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'},status:{type:'string',enum:['resolved','excluded','unresolved']},allSelectionsHandled:{type:'boolean'},reason:{type:'string'},attempts:{type:'array',items:{type:'string'},minItems:1}},required:['startedAt','sourceId','accountId','sourceUrl','status','reason','attempts'],additionalProperties:false}},
  { name: 'sports_picks_freshness', description: 'Run FIRST, before reading or interpreting anything. Give the source identifiers, exact post links, posted timestamps and content hashes you can see without interpreting them. Returns only the material no previous successful receipt already covered. When it returns stop:true it has already written the run receipt and the pass is over: do not read, transcribe, classify or capture anything.', inputSchema: { type:'object', properties:{ startedAt:{type:'string'}, accountsChecked:{type:'integer',minimum:0}, accountsBlocked:{type:'integer',minimum:0}, checksSaved:{type:'integer',minimum:0}, note:{type:'string'}, candidates:{type:'array',items:{type:'object',properties:{sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'},postedAt:{type:'string'},contentHash:{type:'string'}},required:['sourceId','accountId','sourceUrl'],additionalProperties:true}} }, required:['startedAt','candidates'], additionalProperties:false } },
  { name: 'sports_picks_read', description: 'Read the private Sports Picks desk and its configured creator roster. The local automation token is read privately from disk.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sports_picks_list_tiktok', description: 'Fallback listing for one configured public TikTok account when its signed-in browser profile grid errors. Uses the already-installed local yt-dlp once, without browser cookies, credentials, login bypass or retries. Returns exact recent post URLs for shallow inventory. A private/embedding-disabled account remains blocked.', inputSchema:{type:'object',properties:{accountId:{type:'string'},limit:{type:'integer',minimum:1,maximum:12}},required:['accountId'],additionalProperties:false} },
  { name: 'sports_picks_capture', description: 'Save one new source pick to the private desk. The Worker derives firm, Lean, or review from originalText. Require eventStartAt (ISO with timezone) and eventTimeSource (official schedule URL). Check current event status; skip started/completed/cancelled games. Never infer game date from post date. Never invent unknown fields.', inputSchema: { type: 'object', properties: { sourceId:{type:'string'}, accountId:{type:'string'}, sport:{type:'string',enum:['NFL','MLB']}, market:{type:'string'}, selection:{type:'string'}, event:{type:'string'}, eventDate:{type:'string'}, eventStartAt:{type:'string'}, eventTimeSource:{type:'string'}, odds:{type:['integer','null']}, postedAt:{type:'string'}, sourceUrl:{type:'string'}, originalText:{type:'string'}, capturedBeforeStart:{type:'boolean'}, checkedUrl:{type:'string'}, checkedAt:{type:'string'} }, required:['sourceId','accountId','sport','market','selection','event','eventDate','eventStartAt','eventTimeSource','sourceUrl','originalText','capturedBeforeStart','checkedUrl','checkedAt'], additionalProperties:false } },
  { name: 'sports_picks_transcribe_video', description: 'Transcribe a creator video locally from its exact post URL, save the private audio transcript, and return its transcript id and spoken words. Use only for the creator’s own video; never captions or comments. Second evidence-ladder step after caption/post text; try OCR next when a visible graphic may hold names or odds.', inputSchema: { type:'object', properties:{sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'}}, required:['sourceId','accountId','sourceUrl'], additionalProperties:false } },
  { name: 'sports_picks_ocr_frames', description: 'Run local OCR on frame image paths already extracted from a creator post. Third step in the evidence ladder after caption/post text and local transcript. Comments are never pick evidence. Returns extracted text only; unknown fields stay null.', inputSchema: { type:'object', properties:{ sourceId:{type:'string'}, accountId:{type:'string'}, sourceUrl:{type:'string'}, framePaths:{type:'array',items:{type:'string'},minItems:1} }, required:['sourceId','accountId','sourceUrl','framePaths'], additionalProperties:false } },
  { name: 'sports_picks_source_check', description: 'Record one source check after actually checking that creator. Do not use this to create a pick.', inputSchema: { type:'object', properties:{sourceId:{type:'string'},status:{type:'string',enum:['Checked','No new posts','Sign-in needed','Access blocked','Needs review']},note:{type:'string'}}, required:['sourceId','status','note'], additionalProperties:false } },
  { name: 'sports_picks_run_receipt', description: 'Write the single final receipt for this scheduled Sports Picks pass. Call exactly once at the end, including if blocked or failed. A run without this receipt is not verified. Primary note is auto-built as a creator-grouped plain picks list from captures in this run; put hashes/freshness/debug only in technicalNote. Before Needs review, attempt caption → local transcript → OCR.', inputSchema: { type:'object', properties:{outcome:{type:'string',enum:['complete','no_work','blocked','failed']},accountsChecked:{type:'integer',minimum:0},accountsBlocked:{type:'integer',minimum:0},picksSaved:{type:'integer',minimum:0},checksSaved:{type:'integer',minimum:0},note:{type:'string'},technicalNote:{type:'string'},needsReview:{type:'array',items:{type:'object',properties:{creator:{type:'string'},pick:{type:'string'},missing:{type:'string'}},additionalProperties:false}},startedAt:{type:'string'}}, required:['outcome','accountsChecked','accountsBlocked','picksSaved','checksSaved','startedAt'], additionalProperties:false } }
];

// Keep this intentionally aligned with the dashboard's capture classifier. The
// caller supplies evidence only; classification never becomes an agent choice.
const LEAN = /\b(?:lean(?:ing|s)?(?:\s+(?:toward|towards|to))?|would\s+have\s+to\s+lean|i'?d\s+lean|maybe|probably|might|i'?d\s+say|i\s+guess|slight(?:ly)?|kind\s+of\s+like|if\s+i\s+had\s+to)\b/i;
const FIRM = /\b(?:(?:we(?:'re|\s+are)?|i(?:'m|\s+am)?)\s+(?:gonna\s+|going\s+to\s+)?go(?:ing)?\s+with|(?:my|our)\s+(?:picks?|plays?)\s*(?:are|is|:)|(?:hr|home\s*run)\s+calls|give\s+me|gimme|i\s+love|i'?m\s+(?:on|taking|riding|playing)|lock(?:ed)?\s+it\s+in|lock\s+of\s+the\s+day|take\s+the|i\s+like\s+the|hammer(?:ing)?|my\s+pick\s+is|we'?re\s+taking|the\s+play\s+is|bet\s+the|potd|same[ -]?game\s+parlay|\bsgp\b|home\s*run\s+favou?rite\s+order)\b/i;
const DIRECT_CARD = /\b(?:add(?:ing)?\s+(?:this|it)?\s*to\s+(?:the|my|our)\s+card|first\s+touchdown\s+scorer(?:\s+lotto)?|anytime\s+touchdown(?:\s+scorer)?|(?:official|final)\s+(?:pick|play)|card\s*(?:is|:)|cheat\s*sheet)\b/i;
const RELAYED = /\b(?:comments?|commenters?|someone|somebody|you\s+guys|dm(?:ed|s)?|chat\s+said|caption\s+says|he\s+said|she\s+said|they\s+said)\b/i;
function normalized(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function classify(text, selection = '') {
  const rows = String(text || '').split(/(?<=[.!?])\s+|\n+/).map(row => row.trim()).filter(Boolean);
  const statedSelection = normalized(selection);
  let lean = false;
  for (const row of rows) {
    if (RELAYED.test(row)) continue;
    if (LEAN.test(row)) lean = true;
    else if (FIRM.test(row) || DIRECT_CARD.test(row) || (statedSelection && normalized(row).includes(statedSelection))) return {outcome:'firm', reason:''};
  }
  return lean ? {outcome:'lean', reason:''} : {outcome:'unclear', reason:'No stated pick or lean in the captured wording.'};
}

function token() {
  let value;
  try { value = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { throw new Error('Sports Picks token file is unavailable on this Mac.'); }
  if (value.length < 32) throw new Error('Sports Picks token file is invalid.');
  return value;
}

async function request(action, payload = {}) {
  const response = await fetch(WORKER_URL, { method:'POST', headers:{'content-type':'application/json'}, signal:AbortSignal.timeout(20000), body:JSON.stringify({action, agentToken:token(), ...payload}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Sports Picks request failed (${response.status}).`);
  return body;
}

// The health center reads this local mirror.  It contains only the final
// aggregate receipt, never the automation token or private pick evidence.
function mirrorReceipt(receipt) {
  const directory = path.join(__dirname, 'agent-health');
  const target = path.join(directory, 'sports-picks.json');
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

// Material the gate released this pass. It is marked as interpreted only when a
// successful aggregate receipt is written, so an abandoned pass re-releases it.
let pendingFresh = [];
let pendingCaptures = [];

function loadRoster() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'picks-roster.json'), 'utf8')); }
  catch { return []; }
}

function buildReceiptNote(args) {
  const technical = String(args.technicalNote || args.note || '').trim();
  const report = formatRunReport({
    accountsChecked: Number.isInteger(args.accountsChecked) ? args.accountsChecked : 0,
    picks: pendingCaptures,
    needsReview: Array.isArray(args.needsReview) ? args.needsReview : [],
    unfinishedPosts: args.unfinishedPosts || 0,
    technical,
    roster: loadRoster(),
  });
  return boundedReceiptNote(report);
}

let awake;
function keepAwake() {
  if (process.platform !== 'darwin' || awake) return;
  awake = spawn('/usr/bin/caffeinate',['-i','-t','1800'],{stdio:'ignore'});
  awake.on('error',()=>{awake=null;});
  awake.on('exit',()=>{awake=null;});
}
function releaseAwake() { if (awake) {awake.kill();awake=null;} }

function configuredTikTok(accountId) {
  let roster;
  try { roster=JSON.parse(fs.readFileSync(ROSTER_FILE,'utf8')); }
  catch { throw Error('The private picks roster is unavailable on this Mac.'); }
  for (const creator of roster) for (const account of creator.accounts || []) {
    if (account.id === accountId && String(account.platform).toLowerCase() === 'tiktok' && /^https:\/\//.test(account.url || '')) return {sourceId:creator.id,...account};
  }
  throw Error('Choose a configured TikTok account from sports_picks_read.');
}

function listTikTok(args) {
  const account=configuredTikTok(args.accountId), limit=args.limit || 6;
  const binary=path.join(process.env.HOME || '', '.local', 'bin', 'yt-dlp');
  return new Promise((resolve,reject)=>{
    const child=spawn(binary,['--flat-playlist','--playlist-end',String(limit),'--dump-single-json',account.url],{stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    const deadline=setTimeout(()=>{child.kill('SIGKILL');reject(Error('TikTok fallback timed out; checkpoint this account blocked and continue.'));},45000);
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
    child.once('error',error=>{clearTimeout(deadline);reject(error);});
    child.once('close',code=>{
      clearTimeout(deadline);
      if(code){
        const privateAccount=/private|embedding disabled|log into an account/i.test(errors);
        return resolve({accountId:account.id,sourceId:account.sourceId,status:'blocked',candidates:[],reason:privateAccount?'TikTok marks this account private or embedding-disabled; the credential-free fallback cannot list it.':'TikTok public listing failed; browser and local fallback are both unavailable.'});
      }
      try{
        const data=JSON.parse(output), candidates=(data.entries || []).filter(item=>item?.id).map(item=>{
          const accountUrl=new URL(account.url);
          const sourceUrl=item.webpage_url || new URL(`${accountUrl.pathname.replace(/\/$/,'')}/video/${item.id}`,accountUrl.origin).href;
          const title=String(item.title || item.description || '').trim();
          return {sourceId:account.sourceId,accountId:account.id,sourceUrl,postedAt:item.timestamp?new Date(item.timestamp*1000).toISOString():'',contentHash:crypto.createHash('sha256').update(`${item.id}\n${title}`).digest('hex'),title};
        });
        resolve({accountId:account.id,sourceId:account.sourceId,status:'checked',candidates,reason:`Local public fallback returned ${candidates.length} recent TikTok post${candidates.length===1?'':'s'} without browser credentials.`});
      }catch{reject(Error('TikTok fallback returned unreadable data; checkpoint this account blocked and continue.'));}
    });
  });
}
process.once('exit',releaseAwake);
function result(value) { return { content:[{type:'text',text:JSON.stringify(value)}] }; }
function failure(error) { return { content:[{type:'text',text:JSON.stringify({error:error.message})}], isError:true }; }


function ocrFrames(framePaths) {
  const script = path.join(__dirname, 'bin', 'ocr-frames.swift');
  return new Promise((resolve, reject) => {
    const child = spawn('swift', [script, ...framePaths], { stdio:['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local evidence tool timed out after 120 seconds; leave this post unresolved.')); },120000);
    child.once('error',()=>clearTimeout(deadline));
    child.once('close',()=>clearTimeout(deadline));
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const data = JSON.parse(output || '[]');
        if (!code) {
          return resolve({
            ok: true,
            frames: data,
            text: data.map(row => row.text).filter(Boolean).join('\n'),
            evidenceLadderInstruction: evidenceLadderInstruction(),
          });
        }
        reject(new Error(errors.trim() || 'Local OCR failed.'));
      } catch { reject(new Error(errors.trim() || 'Local OCR returned an invalid response.')); }
    });
  });
}

function transcribeVideo(url) {
  const script = path.join(__dirname, 'bin', 'transcribe-social-video.py');
  return new Promise((resolve, reject) => {
    const child = spawn(script, [url], { stdio:['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Local evidence tool timed out after 120 seconds; leave this post unresolved.')); },120000);
    child.once('error',()=>clearTimeout(deadline));
    child.once('close',()=>clearTimeout(deadline));
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const data = JSON.parse(output);
        if (!code && data.ok) return resolve(data);
        reject(new Error(data.error || errors.trim() || 'Local video transcription failed.'));
      } catch { reject(new Error(errors.trim() || 'Local video transcription returned an invalid response.')); }
    });
  });
}

function assertUpcoming(pick, now = Date.now()) {
  const start = Date.parse(pick.eventStartAt);
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(pick.eventStartAt || '') || !Number.isFinite(start) || start <= now) throw Error('Do not capture: game has started or its start time is unverified. Verify the official schedule; never guess.');
  if (!/^https:\/\//.test(pick.eventTimeSource || '')) throw Error('An official schedule evidence URL is required.');
  const day = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(start));
  if (pick.eventDate !== day || pick.capturedBeforeStart !== true) throw Error('Event date/timing must match the verified future start in Eastern time.');
}

async function handle(message) {
  if (message.method === 'initialize') return { jsonrpc:'2.0', id:message.id, result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'sports-picks-local',version:'2.1.0'}} };
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'tools/list') return { jsonrpc:'2.0', id:message.id, result:{tools} };
  if (message.method === 'tools/call') {
    try {
      const args = message.params?.arguments ?? {};
      const validate = require('./picks-validators.js')[message.params?.name];
      if (typeof validate !== 'function') throw new Error('Unknown Sports Picks tool.');
      if (!validate(args)) throw new Error('Invalid tool arguments: ' + validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; '));
      let value;
      if (message.params?.name === 'sports_picks_read') value = {...await request('read'), activeRun:runState.read(__dirname)};
      else if (message.params?.name === 'sports_picks_list_tiktok') value = await listTikTok(args);
      else if (message.params?.name === 'sports_picks_checkpoint') { const state = runState.checkpoint(__dirname,args); keepAwake(); value = {startedAt:state.startedAt, checkpointSaved:true, accountsCheckpointed:Object.keys(state.inventory || {}).length, unfinishedPosts:runState.summarize(state).pending.length, recoveryFrom:state.recoveryFrom || null, instruction:state.recoveryFrom ? 'Inventory current NFL/MLB posts FIRST on every scheduled pass, even with recoveryFrom. Then process fresh material before retained retries. Old deferred posts are history, not proof of expiry. Never skip discovery because a backlog exists.' : 'Checkpoint each account immediately after inventory.', idleSleepProtection:!!awake}; }
      else if (message.params?.name === 'sports_picks_resolve_post') value = runState.resolve(__dirname,args);
      else if (message.params?.name === 'sports_picks_capture') {
        assertUpcoming(args);
        const verification = {...classify(args.originalText,args.selection), checkedUrl:args.checkedUrl, checkedAt:args.checkedAt};
        value = await request('save', {pick:args, verification});
        pendingCaptures.push({
          sourceId: args.sourceId,
          accountId: args.accountId,
          selection: args.selection,
          odds: args.odds,
          kind: verification.outcome,
          event: args.event,
          market: args.market,
          sourceUrl: args.sourceUrl,
        });
      }
      else if (message.params?.name === 'sports_picks_transcribe_video') {
        const local = await transcribeVideo(args.sourceUrl);
        value = await saveVideoEvidence(args, local, request);
      }
      else if (message.params?.name === 'sports_picks_source_check') value = await request('check', args);
      else if (message.params?.name === 'sports_picks_ocr_frames') {
        const local = await ocrFrames(args.framePaths);
        value = { sourceId:args.sourceId, accountId:args.accountId, sourceUrl:args.sourceUrl, ...local };
      }
      else if (message.params?.name === 'sports_picks_run_receipt') {
        const state = runState.read(__dirname);
        if (!state || state.closed || state.startedAt !== args.startedAt) throw Error('No matching unfinished run; initialize freshness before writing a receipt.');
        const desk = await request('read');
        // Read back persisted records, including captures made before a bridge restart.
        pendingCaptures = runState.savedSince(desk, args.startedAt);
        const {completed, pending} = runState.summarize(state);
        const currentPending = runState.summarizeCurrent(state).pending;
        const actual = {...args, picksSaved:pendingCaptures.length,
          needsReview:args.needsReview || [], unfinishedPosts:currentPending.length};
        if ((currentPending.length || args.accountsBlocked > 0 || actual.needsReview.length) && ['complete','no_work'].includes(actual.outcome)) actual.outcome = 'blocked';
        if (actual.outcome === 'no_work' && actual.picksSaved) actual.outcome = 'complete';
        const receipt = {...actual, note:buildReceiptNote(actual)};
        delete receipt.technicalNote;
        delete receipt.needsReview;
        delete receipt.unfinishedPosts;
        value = await request('receipt', {receipt});
        mirrorReceipt(value.receipt);
        releaseAwake();
        // Only explicit per-post results consume material, even in a partial run.
        if (actual.outcome !== 'failed' && completed.length) freshness.commit(__dirname, completed, {...value.receipt,outcome:'complete'});
        runState.write(__dirname,{...state,closed:true,receiptId:value.receipt.id});
        fs.writeFileSync(path.join(__dirname,'agent-health','sports-picks-report.json'), JSON.stringify({receipt:value.receipt,picks:pendingCaptures,unresolved:pending,needsReview:actual.needsReview}),{mode:0o600});
        value = {...value, unresolvedPosts:currentPending.length, deferredEvidenceBacklog:pending.length-currentPending.length, instruction:'Use persisted receipt counts. Current unresolved posts remain fresh; older unknown evidence stays deferred and must not be reported as current unfinished work.'};
        pendingFresh = []; pendingCaptures = [];
      }
      else if (message.params?.name === 'sports_picks_freshness') {
        // Read the private desk locally through the restricted token so the gate
        // can bootstrap from records saved before the local coverage index existed.
        // No creator source is opened and no model interprets this data.
        const desk = await request('read');
        const checkpointed = runState.read(__dirname);
        const inventory = checkpointed?.startedAt === args.startedAt ? Object.values(checkpointed.inventory || {}).flatMap(a => a.candidates) : [];
        const decision = freshness.evaluate(__dirname, [...inventory,...(args.candidates || [])], desk.picks);
        const active = runState.start(__dirname, args.startedAt, decision.coverage);
        // A resumed run cannot hide unfinished posts with an empty inventory.
        if (runState.summarizeCurrent(active).pending.length) decision.stop = false;
        if (decision.stop) {
          const receipt = freshness.zeroReceipt(args);
          const written = await request('receipt', {receipt});
          mirrorReceipt(written.receipt);
          releaseAwake();
          runState.write(__dirname,{...active,closed:true,receiptId:written.receipt.id});
          if (decision.coverage.length) freshness.commit(__dirname, decision.coverage, written.receipt);
          pendingFresh = [];
          pendingCaptures = [];
          value = {stop:true, counts:decision.counts, lastReceiptCompletedAt:decision.lastReceiptCompletedAt,
                   receipt:written.receipt,
                   instruction:'Nothing is new since the last successful receipt. The receipt is written and this pass is complete. Do not read, transcribe, classify or capture anything.'};
        } else {
          // Only explicit successful receipts advance coverage. A timestamp
          // alone does not prove an older post was inspected.
          pendingFresh = decision.coverage;
          value = {stop:false, counts:decision.counts, lastReceiptCompletedAt:decision.lastReceiptCompletedAt,
                   fresh:runState.summarize(active).pending.map(f => f.candidate), skipped:decision.skipped,
                   instruction:'Interpret only fresh material. Call sports_picks_resolve_post for every returned post after evidence work. Partial capture is unresolved, not covered. Reuse activeRun.startedAt after interruptions. ' + evidenceLadderInstruction()};
        }
      }
      else throw new Error('Unknown Sports Picks tool.');
      return { jsonrpc:'2.0', id:message.id, result:result(value) };
    } catch (error) { return { jsonrpc:'2.0', id:message.id, result:failure(error) }; }
  }
  return message.id === undefined ? null : {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
}

async function saveVideoEvidence(args, local, send) {
  const spoken = typeof local.transcript === 'string' ? local.transcript.trim() : '';
  const visualText = Array.isArray(local.visualText) ? local.visualText : [];
  const saved = spoken ? await send('transcript', {transcript:{
    sourceId:args.sourceId, accountId:args.accountId, sourceUrl:args.sourceUrl,
    medium:'audio', engine:local.engine || 'faster-whisper/unknown', transcript:spoken,
    transcribedAt:new Date().toISOString(),
  }}) : {transcript:null};
  return {...saved, spokenText:spoken, visualText, visualMedium:'on-screen OCR',
    instruction:'OCR is visual evidence, not spoken words. Check uncertain names and numbers against the creator graphic before saving a pick.'};
}
module.exports = { assertUpcoming,handle, classify, tools, saveVideoEvidence,configuredTikTok,listTikTok};
if (require.main === module) {
let buffer = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  buffer += chunk;
  const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    queue = queue.then(async () => {
      try { const response = await handle(JSON.parse(line)); if (response) process.stdout.write(JSON.stringify(response)+'\n'); }
      catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC message'}})+'\n'); }
    });
  }
});

}
