import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {assertUpcoming}=require('../picks-mcp.js');
const {formatRunReport}=require('../picks-run-report.js');
const state=require('../picks-run-state.js');
const gate=require('../picks-freshness.js');
const now=Date.parse('2026-09-21T21:00:00Z');
const pick={eventStartAt:'2026-09-22T00:15:00Z',eventDate:'2026-09-21',eventTimeSource:'https://example.com/official',capturedBeforeStart:true,selection:'Example pick',status:'pending'};
test('capture requires a future verified start, correct Eastern date and timezone',()=>{
 assert.doesNotThrow(()=>assertUpcoming(pick,now));
 for(const change of [{eventStartAt:'2026-09-21T20:00:00Z'},{eventStartAt:''},{eventStartAt:'2026-09-22T00:15:00'},{eventTimeSource:''},{eventDate:'2026-09-22'},{capturedBeforeStart:false}])assert.throws(()=>assertUpcoming({...pick,...change},now));
 assert.throws(()=>assertUpcoming(pick,Date.parse(pick.eventStartAt)));
});
test('recommendation report hides started, settled and undated picks, preserves counts',()=>{
 const rows=[pick,{...pick,eventStartAt:'2026-09-20T20:00:00Z'},{...pick,status:'win'},{...pick,eventStartAt:''}];
 const r=formatRunReport({picks:rows,now});assert.equal(r.counts.picksListed,1);assert.equal(r.counts.picksSaved,4);
});
test('new inventory leads same-day recovery and next-day unknown backlog is deferred',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'current-picks-'));
 try {
 const a={sourceId:'example',accountId:'a',sourceUrl:'https://example.com/old'};
 const b={...a,sourceUrl:'https://example.com/new'};
 state.start(root,'2026-09-21T15:00:00Z',gate.evaluate(root,[a]).fresh);
 state.write(root,{...state.read(root),closed:true});
 const next=state.start(root,'2026-09-21T21:00:00Z',gate.evaluate(root,[b]).fresh);
 assert.deepEqual(next.released.map(x=>x.candidate.sourceUrl),[b.sourceUrl,a.sourceUrl]);
 state.write(root,{...next,closed:true});
 const tomorrow=state.start(root,'2026-09-22T15:00:00Z',[]);
 assert.equal(tomorrow.released.length,0);assert.equal(tomorrow.deferred.length,2);
 assert.equal(gate.evaluate(root,[a,b]).fresh.length,2);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
