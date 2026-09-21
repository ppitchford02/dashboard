import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
test('MCP receipt reads persisted counts and leaves unreviewed source pending across restart',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-receipt-'));
  for(const f of ['picks-mcp.js','picks-validators.js','picks-freshness.js','picks-run-state.js','picks-run-report.js','picks-evidence-ladder.js']) fs.copyFileSync(new URL('../'+f,import.meta.url),path.join(root,f));
  fs.writeFileSync(path.join(root,'token'),'test-only-'.repeat(8));
  const prevToken=process.env.PICKS_TOKEN_FILE, prevFetch=global.fetch;
  process.env.PICKS_TOKEN_FILE=path.join(root,'token');
  const at='2026-09-20T15:00:00Z';
  const A={sourceId:'example',accountId:'a',sourceUrl:'https://example.com/1'};
  const B={...A,sourceUrl:'https://example.com/2'};
  let records=[],written;
  global.fetch=async(_url,opts)=>{
    const body=JSON.parse(opts.body);
    if(body.action==='read') return {ok:true,json:async()=>({picks:records})};
    if(body.action==='receipt') { written=body.receipt; return {ok:true,json:async()=>({receipt:{...written,id:'receipt',completedAt:'2026-09-20T16:00:00Z'}})}; }
    throw Error('Unexpected network action '+body.action);
  };
  try{
    let {handle}=require(path.join(root,'picks-mcp.js'));
    const call=async(name,args)=>{const response=await handle({id:1,method:'tools/call',params:{name,arguments:args}}); assert.ok(!response.result.isError,JSON.stringify(response));return JSON.parse(response.result.content[0].text);};
    await call('sports_picks_freshness',{startedAt:at,candidates:[A,B]});
    await call('sports_picks_resolve_post',{...A,startedAt:at,status:'resolved',allSelectionsHandled:true,reason:'all rows captured',attempts:['read full image']});
    records=[{...A,id:'1',createdAt:at,selection:'Player A HR',kind:'firm',status:'pending'},{...A,id:'2',createdAt:at,selection:'Player B',kind:'unclear',status:'review'}];
    delete require.cache[require.resolve(path.join(root,'picks-mcp.js'))];
    ({handle}=require(path.join(root,'picks-mcp.js')));
    await call('sports_picks_run_receipt',{startedAt:at,outcome:'complete',accountsChecked:11,accountsBlocked:0,picksSaved:99,checksSaved:0});
    assert.equal(written.picksSaved,2);assert.equal(written.outcome,'blocked');assert.match(written.note,/2 picks saved/);assert.match(written.note,/1 unfinished posts/);assert.match(written.note,/0 need review/);
    const gate=require(path.join(root,'picks-freshness.js'));
    assert.deepEqual(gate.evaluate(root,[A,B],records).fresh.map(x=>x.candidate),[B]);
  } finally {global.fetch=prevFetch;if(prevToken===undefined)delete process.env.PICKS_TOKEN_FILE;else process.env.PICKS_TOKEN_FILE=prevToken;}
});
