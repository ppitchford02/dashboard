import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const state=require('../picks-run-state.js');
const gate=require('../picks-freshness.js');
const {formatRunReport}=require('../picks-run-report.js');
const A={sourceId:'example',accountId:'a',sourceUrl:'https://example.com/post/1'};
const B={...A,sourceUrl:'https://example.com/post/2'};
const at='2026-09-20T15:00:00Z';
const root=()=>fs.mkdtempSync(path.join(os.tmpdir(),'pick-state-'));
test('partial save does not consume an entire cheat sheet',()=>{
  const r=root();
  assert.equal(gate.evaluate(r,[A],[{...A,selection:'one row'}]).fresh.length,1);
});
test('uninspected and unresolved posts survive while explicit completed posts skip',()=>{
  const r=root(); const d=gate.evaluate(r,[A,B]); state.start(r,at,d.fresh);
  assert.throws(()=>state.resolve(r,{...A,startedAt:at,status:'resolved',reason:'one saved',attempts:['read graphic']}),/every selection/);
  state.resolve(r,{...A,startedAt:at,status:'resolved',allSelectionsHandled:true,reason:'all rows saved',attempts:['full graphic and legend read']});
  const summary=state.summarize(state.read(r));
  assert.equal(summary.pending.length,1);
  gate.commit(r,summary.completed,{outcome:'complete'});
  assert.deepEqual(gate.evaluate(r,[A,B]).fresh.map(x=>x.candidate),[B]);
});
test('journal survives restart and refuses unrelated run or uninspected result',()=>{
  const r=root(); state.start(r,at,gate.evaluate(r,[A]).fresh);
  assert.equal(state.read(r).released.length,1);
  assert.throws(()=>state.start(r,'2026-09-20T16:00:00Z',[]),/unfinished/);
  assert.throws(()=>state.resolve(r,{...B,startedAt:at,status:'excluded'}),/not released/);
  assert.throws(()=>state.resolve(r,{...A,startedAt:at,status:'excluded',reason:'old',attempts:[]}),/evidence attempts/);
  assert.equal(state.summarize(state.start(r,at,[])).pending.length,1);
});
test('counts include saved review records and survive empty process memory',()=>{
  const picks=state.savedSince({picks:[
    {id:'old',createdAt:'2026-09-19T15:00:00Z'},
    {id:'a',createdAt:at,status:'pending',selection:'Player A HR'},
    {id:'b',createdAt:at,status:'review',kind:'unclear',selection:'Player B'},
  ]},at);
  assert.equal(picks.length,2);
  const report=formatRunReport({picks});
  assert.equal(report.counts.picksSaved,2);
  assert.equal(report.counts.picksListed,1);
  assert.match(report.primary,/2 picks saved/);
  assert.match(report.primary,/1 saved records awaiting verification/);
});
test('empty inventory with blocked accounts cannot produce no_work',()=>{
  assert.equal(gate.zeroReceipt({accountsBlocked:1}).outcome,'blocked');
});

// Clear recommendation language must not require the exact phrase "give me".
test('spoken go-with and HR-calls headings are recommendations, not automatic review',()=>{
  const {classify}=require('../picks-mcp.js');
  assert.equal(classify("We're gonna go with Player A for 36 receiving yards").outcome,'firm');
  assert.equal(classify('HR CALLS — Player A, Player B').outcome,'firm');
  assert.equal(classify('I might go with Player A').outcome,'lean');
  assert.equal(classify('Comments: my pick is Player A').outcome,'unclear');
  assert.equal(classify('MLB HITS — Player A, Player B').outcome,'unclear');
});
test('inventory is checkpointed before gate and resumes across a reload without claiming coverage',()=>{
 const r=root();state.checkpoint(r,{startedAt:at});
 state.checkpoint(r,{startedAt:at,sourceId:A.sourceId,accountId:A.accountId,status:'checked',candidates:[A]});
 const reload=state.read(r);assert.deepEqual(reload.inventory.a.candidates,[A]);
 assert.equal(reload.released.length,0);assert.equal(gate.evaluate(r,[A]).fresh.length,1);
 state.start(r,at,gate.evaluate(r,[A]).fresh);
 assert.deepEqual(state.read(r).inventory.a.candidates,[A]);
 assert.throws(()=>state.checkpoint(r,{startedAt:at,sourceId:'wrong',accountId:'a',status:'checked',candidates:[A]}),/belong/);
});

test('new pass retains only unfinished posts from a closed partial run',()=>{
 const r=root();state.start(r,at,gate.evaluate(r,[A,B]).fresh);
 state.resolve(r,{...A,startedAt:at,status:'excluded',reason:'not a pick',attempts:['read post']});
 state.write(r,{...state.read(r),closed:true});
 const next=state.checkpoint(r,{startedAt:'2026-09-21T15:00:00Z'});
 assert.deepEqual(state.summarize(next).pending.map(x=>x.candidate),[B]);
 assert.equal(next.recoveryFrom,at);
});
