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
  const report=formatRunReport({picks:picks.map(p=>({...p,eventStartAt:'2099-09-11T23:00:00Z',eventTimeSource:'https://example.com/schedule'}))});
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
 assert.equal(classify('FIRST TOUCHDOWN SCORER LOTTO @everyone DAVANTE ADAMS','Davante Adams — first touchdown scorer').outcome,'firm');
 assert.equal(classify('Kyren Williams 2+ Receptions The Giants allow receiving yards to RBs.','Kyren Williams 2+ receptions').outcome,'firm');
 assert.equal(classify('Something came across my desk that I would like to add to the card: Malachi Fields Over 25.5 Rec Yards (-115)','Malachi Fields Over 25.5 receiving yards').outcome,'firm');
 assert.equal(classify('I might add Player A to the card','Player A').outcome,'lean');
});

test('receipt-facing current summary excludes retained unknown backlog',()=>{
 const r=root();
 state.start(r,at,gate.evaluate(r,[A,B]).fresh);
 state.write(r,{...state.read(r),closed:true});
 const nextAt='2026-09-20T21:00:00Z';
 const C={...A,sourceUrl:'https://example.com/post/3',postedAt:'2026-09-20T20:30:00Z'};
 const next=state.start(r,nextAt,gate.evaluate(r,[C]).fresh);
 assert.equal(state.summarize(next).pending.length,3);
 assert.deepEqual(state.summarizeCurrent(next).pending.map(x=>x.candidate),[C]);
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

test('new day defers old unknown-date posts without declaring coverage',()=>{
 const r=root();state.start(r,at,gate.evaluate(r,[A,B]).fresh);
 state.resolve(r,{...A,startedAt:at,status:'excluded',reason:'not a pick',attempts:['read post']});
 state.write(r,{...state.read(r),closed:true});
 const next=state.checkpoint(r,{startedAt:'2026-09-21T15:00:00Z'});
 assert.deepEqual(state.summarize(next).pending.map(x=>x.candidate),[]);
 assert.deepEqual(next.deferred.map(x=>x.candidate),[B]);
 assert.equal(gate.evaluate(r,[B]).fresh.length,1);
 assert.equal(next.recoveryFrom,at);
});
