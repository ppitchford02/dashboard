import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../worker.js',import.meta.url),'utf8');
const {runTool,runDashboardAction,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
function repo(data){return {writes:0,async read(){return {data:structuredClone(data),sha:'test'};},async write(path,updated){this.writes++;this.updated=updated;}};}
test('ambiguous and empty removals cannot delete multiple records',async()=>{
 for(const name of ['remove_deadline','remove_attention']){
  const gh=repo({deadlines:[{title:'Memo one'},{title:'Memo two'}],attention:[{title:'Memo one'},{title:'Memo two'}]});
  await assert.rejects(runTool(name,{title_contains:'Memo'},gh),/Several items/);
  await assert.rejects(runTool(name,{title_contains:''},gh),/Missing/);
  assert.equal(gh.writes,0);
 }
});
test('unique removal preserves unrelated items',async()=>{
 const gh=repo({deadlines:[{title:'Memo one'},{title:'Memo two'}]});
 await runTool('remove_deadline',{title_contains:'one'},gh);
 assert.deepEqual(gh.updated.deadlines,[{title:'Memo two'}]);
});
test('invalid dates and status cannot corrupt dashboard',async()=>{
 const gh=repo({deadlines:[],agents:[{name:'Agent'}]});
 for(const due of ['tomorrow','2026-02-30T12:00','2026-13-01T12:00']) await assert.rejects(runTool('add_deadline',{title:'Memo',due},gh),/Invalid due/);
 await assert.rejects(runTool('set_agent_status',{name_contains:'Agent',status:'broken'},gh),/Invalid agent/);
 assert.equal(gh.writes,0);
});
test('valid leap date is saved',async()=>{
 const gh=repo({deadlines:[]});
 await runTool('add_deadline',{title:'Memo',due:'2028-02-29T12:00'},gh);
 assert.equal(gh.writes,1);
});
test('null request body returns JSON error',async()=>{
 const result=await worker.fetch(new Request('https://example.com',{method:'POST',body:'null'}),{});
 assert.equal(result.status,400);
 assert.equal((await result.json()).error,'bad request');
});

function liveRepo(initial){let current=structuredClone(initial);return {writes:0,get data(){return current;},async read(){return {data:structuredClone(current),sha:'version'};},async write(path,data){this.writes++;current=structuredClone(data);return {commit_url:'https://github.com/ppitchford02/dashboard/commit/test'};}};}
test('structured clear and undo restore the exact record and preserve unrelated data',async()=>{
 const item={title:'Memo',body:'Confirm submission',when:'',level:'med',related_deadlines:['Memo due']};
 const original={attention:[{title:'First',body:''},item,{title:'Last',body:''}],deadlines:[{title:'Memo due',due:'2026-09-10T23:59'}],extra:{keep:true}};
 const gh=liveRepo(original);const cleared=await runDashboardAction({name:'complete_attention',item},gh);
 assert.equal(gh.data.attention.length,2);assert.equal(cleared.changed,true);
 await runDashboardAction(cleared.undo,gh);assert.deepEqual(gh.data,original);
});
test('structured add returns an exact undo and cannot create duplicate titles',async()=>{
 const original={attention:[],deadlines:[]},gh=liveRepo(original);
 const saved=await runDashboardAction({name:'add_attention',item:{title:'Review outline',body:'Read section one',level:'low'}},gh);
 assert.ok(saved.undo.item.id);assert.equal(saved.attention.length,1);
 await assert.rejects(runDashboardAction({name:'add_attention',item:{title:'Review outline',body:''}},gh),/already exists/);
 await runDashboardAction(saved.undo,gh);assert.deepEqual(gh.data,original);
});
test('stale structured edits and invalid actions fail without a write',async()=>{
 const gh=liveRepo({attention:[{title:'Memo',body:'New details'}]});
 await assert.rejects(runDashboardAction({name:'complete_attention',item:{title:'Memo',body:'Old details'}},gh),/changed/);
 await assert.rejects(runDashboardAction({name:'write_file',item:{title:'x',body:''}},gh),/Unsupported/);
 await assert.rejects(runDashboardAction({name:'add_attention',item:{title:'x',body:'',level:'broken'}},gh),/Invalid/);
 assert.equal(gh.writes,0);
});
test('dashboard actions require the existing passphrase before any write',async()=>{
 const response=await worker.fetch(new Request('https://example.com',{method:'POST',body:JSON.stringify({action:{name:'add_attention',item:{title:'x',body:''}}})}),{DASH_PASSPHRASE:'test-only'});
 assert.equal(response.status,401);
});
