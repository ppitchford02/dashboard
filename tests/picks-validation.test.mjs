import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {handle,tools,saveVideoEvidence}=require('../picks-mcp.js');
const validators=require('../picks-validators.js');

test('compiled validators match every published tool schema',()=>{
  const hash=crypto.createHash('sha256').update(JSON.stringify(tools.map(t=>[t.name,t.inputSchema]))).digest('hex');
  assert.equal(validators.schemaHash,hash);
  for(const tool of tools)assert.equal(typeof validators[tool.name],'function');
});

test('invalid tool arguments fail before credentials or network and do not echo evidence',async()=>{
  const original=global.fetch; let calls=0;
  global.fetch=()=>{calls++;throw Error('Unexpected network');};
  try{
    for(const [name,args] of [['sports_picks_capture',{}],['sports_picks_read',{secret:'PRIVATE_EVIDENCE'}],['sports_picks_read',[]],['sports_picks_run_receipt',{outcome:'complete',accountsChecked:-1,accountsBlocked:0,picksSaved:0,checksSaved:0,startedAt:'now'}]]){
      const r=await handle({id:1,method:'tools/call',params:{name,arguments:args}});
      assert.equal(r.result.isError,true);assert.match(r.result.content[0].text,/Invalid tool arguments/);assert.doesNotMatch(r.result.content[0].text,/PRIVATE_EVIDENCE/);
    }
    assert.equal(calls,0);
  }finally{global.fetch=original;}
});

test('video intake stores spoken evidence only and reports actual engine',async()=>{
  let payload;
  const result=await saveVideoEvidence({sourceId:'example',accountId:'one',sourceUrl:'https://example.com/video'},
    {transcript:'Spoken selection',visualText:['Visible odds'],engine:'faster-whisper/tiny.en'},async(action,body)=>{assert.equal(action,'transcript');payload=body;return {id:'t1'};});
  assert.equal(payload.transcript.transcript,'Spoken selection');assert.equal(payload.transcript.engine,'faster-whisper/tiny.en');
  assert.deepEqual(result.visualText,['Visible odds']);assert.equal(result.id,'t1');
});

test('visual-only video never creates an audio transcript',async()=>{
  const result=await saveVideoEvidence({}, {transcript:'',visualText:['Player on screen']},()=>{throw Error('Must not store audio');});
  assert.equal(result.transcript,null);assert.deepEqual(result.visualText,['Player on screen']);
});
