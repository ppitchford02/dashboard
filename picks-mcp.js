#!/usr/bin/env node
/*
 * Local, token-scoped MCP bridge for the private Sports Picks Worker.
 * It never returns, logs, or accepts the automation token as a tool argument.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WORKER_URL = process.env.PICKS_WORKER_URL || 'https://pitchford-os-ask.ppitchford02.workers.dev/picks';
const TOKEN_FILE = process.env.PICKS_TOKEN_FILE || path.join(process.env.HOME || '', 'dashboard', 'picks-agent-token.txt');

const tools = [
  { name: 'sports_picks_read', description: 'Read the private Sports Picks desk and its configured creator roster. The local automation token is read privately from disk.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'sports_picks_capture', description: 'Save one new source pick to the private desk. The Worker derives firm, Lean, or review from originalText. Never invent unknown fields.', inputSchema: { type: 'object', properties: { sourceId:{type:'string'}, accountId:{type:'string'}, sport:{type:'string',enum:['NFL','MLB']}, market:{type:'string'}, selection:{type:'string'}, event:{type:'string'}, eventDate:{type:'string'}, odds:{type:['integer','null']}, postedAt:{type:'string'}, sourceUrl:{type:'string'}, originalText:{type:'string'}, capturedBeforeStart:{type:'boolean'}, checkedUrl:{type:'string'}, checkedAt:{type:'string'} }, required:['sourceId','accountId','sport','market','selection','event','eventDate','sourceUrl','originalText','capturedBeforeStart','checkedUrl','checkedAt'], additionalProperties:false } },
  { name: 'sports_picks_transcribe_video', description: 'Transcribe a creator video locally from its exact post URL, save the private audio transcript, and return its transcript id and spoken words. Use only for the creator’s own video; never captions or comments.', inputSchema: { type:'object', properties:{sourceId:{type:'string'},accountId:{type:'string'},sourceUrl:{type:'string'}}, required:['sourceId','accountId','sourceUrl'], additionalProperties:false } },
  { name: 'sports_picks_source_check', description: 'Record one source check after actually checking that creator. Do not use this to create a pick.', inputSchema: { type:'object', properties:{sourceId:{type:'string'},status:{type:'string',enum:['Checked','No new posts','Sign-in needed','Access blocked','Needs review']},note:{type:'string'}}, required:['sourceId','status','note'], additionalProperties:false } },
  { name: 'sports_picks_run_receipt', description: 'Write the single final receipt for this scheduled Sports Picks pass. Call exactly once at the end, including if blocked or failed. A run without this receipt is not verified.', inputSchema: { type:'object', properties:{outcome:{type:'string',enum:['complete','no_work','blocked','failed']},accountsChecked:{type:'integer',minimum:0},accountsBlocked:{type:'integer',minimum:0},picksSaved:{type:'integer',minimum:0},checksSaved:{type:'integer',minimum:0},note:{type:'string'},startedAt:{type:'string'}}, required:['outcome','accountsChecked','accountsBlocked','picksSaved','checksSaved','note','startedAt'], additionalProperties:false } },
];

// Keep this intentionally aligned with the dashboard's capture classifier. The
// caller supplies evidence only; classification never becomes an agent choice.
const LEAN = /\b(?:lean(?:ing|s)?(?:\s+(?:toward|towards|to))?|would\s+have\s+to\s+lean|i'?d\s+lean|maybe|probably|might|i'?d\s+say|i\s+guess|slight(?:ly)?|kind\s+of\s+like|if\s+i\s+had\s+to)\b/i;
const FIRM = /\b(?:give\s+me|gimme|i\s+love|i'?m\s+(?:on|taking|riding|playing)|lock(?:ed)?\s+it\s+in|lock\s+of\s+the\s+day|take\s+the|i\s+like\s+the|hammer(?:ing)?|my\s+pick\s+is|we'?re\s+taking|the\s+play\s+is|bet\s+the|potd|same[ -]?game\s+parlay|\bsgp\b|home\s*run\s+favou?rite\s+order)\b/i;
const RELAYED = /\b(?:comments?|commenters?|someone|somebody|you\s+guys|dm(?:ed|s)?|chat\s+said|caption\s+says|he\s+said|she\s+said|they\s+said)\b/i;
function classify(text) {
  const rows = String(text || '').split(/(?<=[.!?])\s+|\n+/).map(row => row.trim()).filter(Boolean);
  let lean = false;
  for (const row of rows) {
    if (RELAYED.test(row)) continue;
    if (LEAN.test(row)) lean = true;
    else if (FIRM.test(row)) return {outcome:'firm', reason:''};
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
  const response = await fetch(WORKER_URL, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action, agentToken:token(), ...payload}) });
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

function result(value) { return { content:[{type:'text',text:JSON.stringify(value)}] }; }
function failure(error) { return { content:[{type:'text',text:JSON.stringify({error:error.message})}], isError:true }; }

function transcribeVideo(url) {
  const script = path.join(__dirname, 'bin', 'transcribe-social-video.py');
  return new Promise((resolve, reject) => {
    const child = spawn(script, [url], { stdio:['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
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

async function handle(message) {
  if (message.method === 'initialize') return { jsonrpc:'2.0', id:message.id, result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'sports-picks-local',version:'1.0.0'}} };
  if (message.method === 'notifications/initialized') return null;
  if (message.method === 'tools/list') return { jsonrpc:'2.0', id:message.id, result:{tools} };
  if (message.method === 'tools/call') {
    try {
      const args = message.params?.arguments || {};
      let value;
      if (message.params?.name === 'sports_picks_read') value = await request('read');
      else if (message.params?.name === 'sports_picks_capture') {
        const verification = {...classify(args.originalText), checkedUrl:args.checkedUrl, checkedAt:args.checkedAt};
        value = await request('save', {pick:args, verification});
      }
      else if (message.params?.name === 'sports_picks_transcribe_video') {
        const local = await transcribeVideo(args.sourceUrl);
        value = await request('transcript', {transcript:{
          sourceId:args.sourceId, accountId:args.accountId, sourceUrl:args.sourceUrl,
          medium:'audio', engine:'faster-whisper/base.en', transcript:local.transcript,
          transcribedAt:new Date().toISOString(),
        }});
      }
      else if (message.params?.name === 'sports_picks_source_check') value = await request('check', args);
      else if (message.params?.name === 'sports_picks_run_receipt') {
        value = await request('receipt', {receipt:args});
        mirrorReceipt(value.receipt);
      }
      else throw new Error('Unknown Sports Picks tool.');
      return { jsonrpc:'2.0', id:message.id, result:result(value) };
    } catch (error) { return { jsonrpc:'2.0', id:message.id, result:failure(error) }; }
  }
  return message.id === undefined ? null : {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async chunk => {
  buffer += chunk;
  const lines = buffer.split('\n'); buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { const response = await handle(JSON.parse(line)); if (response) process.stdout.write(JSON.stringify(response)+'\n'); }
    catch { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON-RPC message'}})+'\n'); }
  }
});
