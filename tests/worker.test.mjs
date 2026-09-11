import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../worker.js',import.meta.url),'utf8');
const {runTool,runDashboardAction,handlePlannerRequest,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
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

// --- private daily planner -------------------------------------------------
// A small D1 double: the handler only issues three statements, matched here by
// leading keyword. It exercises the handler, not SQLite.
function plannerDb(rows=new Map()){
 const key=(owner,day)=>`${owner}|${day}`;
 return {rows,prepare(sql){const self=this;return {bind(...args){return {
  async first(){if(!/^SELECT/.test(sql))throw new Error('unexpected '+sql);const [owner,day]=args;return self.rows.get(key(owner,day))||null;},
  async run(){
   if(/^INSERT/.test(sql)){const [owner,day,tasks,prompted]=args;if(self.rows.has(key(owner,day)))return {success:true,meta:{changes:0}};
    self.rows.set(key(owner,day),{owner,day,tasks,prompted,revision:1});return {success:true,meta:{changes:1}};}
   if(/^UPDATE/.test(sql)){const [tasks,prompted,,owner,day,revision]=args;const row=self.rows.get(key(owner,day));
    if(!row||row.revision!==revision)return {success:true,meta:{changes:0}};
    self.rows.set(key(owner,day),{...row,tasks,prompted,revision:row.revision+1});return {success:true,meta:{changes:1}};}
   throw new Error('unexpected '+sql);},
 };}};}};
}
const plannerEnv=db=>({DASH_PASSPHRASE:'secret',PICKS_DB:db});
function plannerPost(body,env,origin='https://ppitchford02.github.io'){
 return handlePlannerRequest(new Request('https://example.com/planner',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)}),env);
}
const plannerBody=async response=>[response.status,await response.json()];

test('the planner rejects a wrong passphrase and a foreign origin before touching storage',async()=>{
 const db=plannerDb();
 assert.equal((await plannerPost({pass:'wrong',action:'read',day:'2026-09-11'},plannerEnv(db))).status,401);
 assert.equal((await plannerPost({pass:'secret',action:'read',day:'2026-09-11'},plannerEnv(db),'https://evil.example')).status,403);
 assert.equal(db.rows.size,0);
});

test('the planner never writes the repository or the public page',async()=>{
 // A GitHub token would be a bug here: today's list must stay off data.json.
 const db=plannerDb();
 const response=await plannerPost({pass:'secret',action:'save',day:'2026-09-11',tasks:[{title:'Draft memo'}],revision:0},plannerEnv(db));
 assert.equal(response.status,200);
 assert.equal(response.headers.get('Cache-Control'),'private, no-store');
 assert.equal(db.rows.size,1);
});

test('a saved list is returned to another device unchanged',async()=>{
 const db=plannerDb();
 await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:[{title:'Read chapter',priority:true},{title:'Take a walk'}]},plannerEnv(db));
 const [status,data]=await plannerBody(await plannerPost({pass:'secret',action:'read',day:'2026-09-11'},plannerEnv(db)));
 assert.equal(status,200);
 assert.equal(data.prompted,true);
 assert.deepEqual(data.tasks,[{title:'Read chapter',done:false,priority:true},{title:'Take a walk',done:false,priority:false}]);
});

test('toggling one task leaves the rest of the list alone',async()=>{
 const db=plannerDb();
 await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:[{title:'Read chapter'},{title:'Take a walk'}]},plannerEnv(db));
 const [status,data]=await plannerBody(await plannerPost({pass:'secret',action:'toggle',day:'2026-09-11',title:'read CHAPTER',done:true},plannerEnv(db)));
 assert.equal(status,200);
 assert.deepEqual(data.tasks.map(t=>[t.title,t.done]),[['Read chapter',true],['Take a walk',false]]);
});

test('a stale save is refused and returns the newer list instead of overwriting it',async()=>{
 const db=plannerDb();
 await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:[{title:'First plan'}]},plannerEnv(db));
 await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:1,tasks:[{title:'Second plan'}]},plannerEnv(db));
 const [status,data]=await plannerBody(await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:1,tasks:[{title:'Stale plan'}]},plannerEnv(db)));
 assert.equal(status,409);
 assert.equal(data.conflict,true);
 assert.deepEqual(data.tasks.map(t=>t.title),['Second plan']);
});

test('invalid days, oversized lists and unknown actions are rejected',async()=>{
 const db=plannerDb();
 for(const day of ['tomorrow','2026-13-01','2026-02-30','2026-9-1'])
  assert.equal((await plannerPost({pass:'secret',action:'read',day},plannerEnv(db))).status,400);
 assert.equal((await plannerPost({pass:'secret',action:'drop',day:'2026-09-11'},plannerEnv(db))).status,400);
 const many=Array.from({length:101},(_,i)=>({title:`Task ${i}`}));
 assert.equal((await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:many},plannerEnv(db))).status,400);
 assert.equal((await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:[{title:'x'.repeat(201)}]},plannerEnv(db))).status,400);
 assert.equal(db.rows.size,0);
});

test('duplicate and blank task titles are collapsed the way the browser collapses them',async()=>{
 const db=plannerDb();
 const [,data]=await plannerBody(await plannerPost({pass:'secret',action:'save',day:'2026-09-11',revision:0,tasks:[{title:'Read chapter'},{title:'  '},{title:'read chapter'},{title:' Take a walk '}]},plannerEnv(db)));
 assert.deepEqual(data.tasks.map(t=>t.title),['Read chapter','Take a walk']);
});

test('dismissing the check-in records it without inventing tasks',async()=>{
 const db=plannerDb();
 const [status,data]=await plannerBody(await plannerPost({pass:'secret',action:'prompted',day:'2026-09-11'},plannerEnv(db)));
 assert.equal(status,200);
 assert.equal(data.prompted,true);
 assert.deepEqual(data.tasks,[]);
});

test('the planner reports unavailable storage without losing the caller’s list',async()=>{
 const response=await plannerPost({pass:'secret',action:'read',day:'2026-09-11'},{DASH_PASSPHRASE:'secret'});
 assert.equal(response.status,503);
 assert.match((await response.json()).error,/kept on this device/);
});
