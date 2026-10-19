import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../worker.js',import.meta.url),'utf8');
const {default:worker,handleWorkTasksRequest}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const item=()=>({id:'a'.repeat(20),title:'Fictional request',project:'demo',owner:'Test agent',status:'waiting',source:'https://example.org/thread',due:'2020-01-01T23:59:59-05:00',waiting_on:'Requestor',reason:'Need one answer',completion_receipt:null});
function db() {
 let row=null;
 return {get row(){return row;},prepare(sql){return {bind(...args){return {
  async first(){assert.match(sql,/SELECT \* FROM work_task_mirror/);return row;},
  async run(){
   if(sql.startsWith('INSERT')) {if(row)return {meta:{changes:0}};row={owner:args[0],revision:1,payload:args[1],synced_at:args[2]};return {meta:{changes:1}};}
   assert.match(sql,/UPDATE work_task_mirror/);
   if(!row||row.revision!==args[3])return {meta:{changes:0}};
   row={...row,payload:args[0],synced_at:args[1],revision:row.revision+1};return {meta:{changes:1}};
  },
 };}};}};
}
function request(body,origin='https://ppitchford02.github.io') {
 return new Request('https://example.org/work-tasks',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
}
const env=database=>({DASH_PASSPHRASE:'fictional-test-only',PICKS_DB:database});

test('work tasks reject authentication and foreign origin before DB use',async()=>{
 const bad={prepare(){throw new Error('Should not touch DB');}};
 assert.equal((await handleWorkTasksRequest(request({pass:'wrong',action:'read'}),env(bad))).status,401);
 assert.equal((await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'read'},'https://other.example'),env(bad))).status,403);
});
test('entry route reaches private queue without invoking model or public actions',async()=>{
 const response=await worker.fetch(request({pass:'fictional-test-only',action:'read'}),env(db()));
 assert.equal(response.status,200);assert.match(response.headers.get('Cache-Control'),/private, no-store/);
 const body=await response.json();assert.deepEqual(body.tasks,[]);assert.equal(body.synced_at,null);
});
test('sync and read preserve source/waiting metadata with no extra secrets',async()=>{
 const database=db(),e=env(database);
 const write=await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'sync',revision:0,tasks:[{...item(),extra:'must not mirror'}]}),e);
 assert.equal(write.status,200);
 const body=await (await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'read'}),e)).json();
 assert.equal(body.tasks[0].source,item().source);assert.equal(body.tasks[0].waiting_on,'Requestor');
 assert.equal(body.tasks[0].extra,undefined);assert.ok(body.synced_at);
});
test('stale snapshot revision refuses replacing newer tasks',async()=>{
 const database=db(),e=env(database);
 const payload={pass:'fictional-test-only',action:'sync',revision:0,tasks:[item()]};
 await handleWorkTasksRequest(request(payload),e);
 const stale=await handleWorkTasksRequest(request({...payload,tasks:[]}),e);
 assert.equal(stale.status,409);assert.equal(JSON.parse(database.row.payload).length,1);
});
test('unsafe source URL, duplicate ID and credential-shaped text never persist',async()=>{
 for(const rows of [[{...item(),source:'javascript:alert(1)'}],[item(),item()],[{...item(),title:'access_token=secret-value'}]]) {
  const database=db();const response=await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'sync',revision:0,tasks:rows}),env(database));
  assert.notEqual(response.status,200);assert.equal(database.row,null);
 }
});
test('completion cannot be changed through a dashboard checkbox action',async()=>{
 const response=await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'toggle',id:item().id,done:true}),env(db()));
 assert.equal(response.status,400);
});
test('missing database/schema returns honest unavailable state',async()=>{
 const response=await handleWorkTasksRequest(request({pass:'fictional-test-only',action:'read'}),env({prepare(){throw new Error('table absent');}}));
 assert.equal(response.status,503);assert.match((await response.json()).error,/unavailable/);
});

const uiSource=readFileSync(new URL('../work-task-desk.js',import.meta.url),'utf8');
function ui(requestFn,unlocked=false) {
 class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.textContent='';}
  append(...items){this.children.push(...items);}
  replaceChildren(){this.children=[];}
  addEventListener(event,fn){this.events[event]=fn;}
 }
 const ids=new Map();const get=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);};
 const window={};
 vm.runInNewContext(uiSource,{document:{getElementById:get,createElement:tag=>new Element(tag)},window,URL,Date});
 window.PitchfordWorkTasks.init({request:requestFn,hasPass:()=>unlocked});
 return {get,load:()=>get('work-task-refresh').events.click()};
}
test('locked UI does not silently poll or trigger a passphrase prompt',()=>{
 let calls=0;ui(async()=>{calls++;});assert.equal(calls,0);
});
test('private UI renders source, owner, waiting state and overdue data as text',async()=>{
 const task={...item(),title:'<script>unsafe</script>'};
 const view=ui(async()=>({tasks:[task],synced_at:'2026-10-19T19:00:00Z'}));await view.load();
 const card=view.get('work-task-list').children[0];
 assert.equal(card.children[0].textContent,task.title);
 assert.ok(card.children.some(x=>x.textContent.includes('Test agent')));
 assert.ok(card.children.some(x=>x.textContent.includes('Requestor')));
 assert.ok(card.children.some(x=>x.textContent.startsWith('Overdue')));
 assert.equal(card.children.find(x=>x.tag==='a').href,task.source);
 assert.match(view.get('work-task-state').textContent,/Not a live inbox scan/);
});
test('UI never turns an unsafe source into an executable link',async()=>{
 const view=ui(async()=>({tasks:[{...item(),source:'javascript:alert(1)'}],synced_at:'today'}));await view.load();
 assert.equal(view.get('work-task-list').children[0].children.some(x=>x.tag==='a'),false);
});
test('failed refresh retains prior snapshot and labels it stale',async()=>{
 let fail=false;const view=ui(async()=>{if(fail)throw new Error('offline');return {tasks:[item()],synced_at:'earlier'};});
 await view.load();fail=true;await view.load();
 assert.equal(view.get('work-task-list').children.length,1);
 assert.match(view.get('work-task-state').textContent,/stale/);
});
test('never-synced empty list is not described as no outstanding obligations',async()=>{
 const view=ui(async()=>({tasks:[],synced_at:null}));await view.load();
 assert.match(view.get('work-task-state').textContent,/does not mean there are no outstanding/);
});

test('sync token gets revision only, uploads snapshots, and cannot read private tasks',async()=>{
 const database=db(),e={...env(database),WORK_TASK_SYNC_TOKEN:'f'.repeat(64)};
 const auth={sync_token:e.WORK_TASK_SYNC_TOKEN};
 assert.deepEqual(await (await worker.fetch(request({...auth,action:'cursor'}),e)).json(),{revision:0});
 assert.equal((await worker.fetch(request({...auth,action:'sync',revision:0,tasks:[item()]}),e)).status,200);
 assert.deepEqual(await (await worker.fetch(request({...auth,action:'cursor'}),e)).json(),{revision:1});
 assert.equal((await worker.fetch(request({...auth,action:'read'}),e)).status,403);
 assert.equal((await worker.fetch(request({...auth,action:'toggle'}),e)).status,403);
 for(const route of ['/planner','/picks','/']) {
  const r=request({...auth,action:'read'});
  const response=await worker.fetch(new Request('https://example.org'+route,r),e);
  assert.equal(response.status,401);
 }
});
test('unset, short and incorrect sync tokens fail closed before touching storage',async()=>{
 const bad={prepare(){throw new Error('DB must not be read');}};
 for(const token of [undefined,'short','e'.repeat(64)]) {
  const e={...env(bad),WORK_TASK_SYNC_TOKEN:'f'.repeat(64)};
  assert.equal((await worker.fetch(request({sync_token:token,action:'cursor'}),e)).status,401);
 }
});
test('automatic refresh is visible/unlocked only and uses bounded one-minute cadence',async()=>{
 const listeners={},winEvents={},ids=new Map();let timer,delay,calls=0,unlocked=false;
 const get=id=>{if(!ids.has(id))ids.set(id,{children:[],textContent:'',addEventListener(){},replaceChildren(){this.children=[];},append(){}});return ids.get(id);};
 const document={hidden:false,getElementById:get,createElement:()=>({}),addEventListener:(name,fn)=>listeners[name]=fn};
 const window={setInterval:(fn,ms)=>{timer=fn;delay=ms;},addEventListener:(name,fn)=>winEvents[name]=fn};
 vm.runInNewContext(uiSource,{document,window,URL,Date});
 window.PitchfordWorkTasks.init({hasPass:()=>unlocked,request:async()=>{calls++;return {tasks:[],synced_at:'today'};}});
 assert.equal(delay,60000);await timer();assert.equal(calls,0);
 unlocked=true;document.hidden=true;await timer();assert.equal(calls,0);
 document.hidden=false;await listeners.visibilitychange();assert.equal(calls,1);
 await timer();assert.equal(calls,2);await winEvents.focus();assert.equal(calls,3);
});
