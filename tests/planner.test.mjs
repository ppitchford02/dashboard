import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../daily-planner.js',import.meta.url),'utf8');
function harness(store=new Map()) {
  let now='2026-09-11T12:59:00Z', tick;
  class Element {
    constructor(){this.children=[];this.listeners={};this.value='';this.open=false;this.hidden=false;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(){this.children=[];}
    addEventListener(name,fn){this.listeners[name]=fn;}
    showModal(){this.open=true;}
    close(){this.open=false;}
    fire(name){this.listeners[name]({preventDefault(){}});}
  }
  const ids=new Map();
  const get=id=>{if(!ids.has(id))ids.set(id,new Element());return ids.get(id);};
  const document={getElementById:get,createElement:()=>new Element(),hidden:false,addEventListener(){},querySelector:()=>null};
  class Clock extends Date{constructor(){super(now);}}
  const sandbox={document,window:{addEventListener(){}},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},Map,Set,Intl,JSON,Date:Clock,setInterval:fn=>{tick=fn;}};
  sandbox.window.PitchfordPlanner=undefined;
  vm.runInNewContext(script,sandbox);
  return {get,store,window:sandbox.window,time:value=>{now=value;tick();}};
}
// Draining the microtask queue lets the optimistic write and its server reply settle.
const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Objects built inside the vm realm are not reference-comparable; compare by value.
const plain=value=>JSON.parse(JSON.stringify(value));

test('9 AM Eastern prompt, priorities, saved checkboxes and next-day reset',()=>{
 const ui=harness(); assert.equal(ui.get('planner-dialog').open,false);
 ui.time('2026-09-11T13:00:00Z'); assert.equal(ui.get('planner-dialog').open,true);
 ui.get('planner-tasks').value='Read chapter\nTake a walk\nread chapter';
 ui.get('planner-priorities').value='Read chapter'; ui.get('planner-form').fire('submit');
 assert.equal(ui.get('planner-list').children.length,2);
 const row=ui.get('planner-list').children[0].children[0];
 assert.equal(row.children[1].textContent,'Read chapter');
 row.children[0].checked=true;row.children[0].fire('change');
 const reloaded=harness(ui.store);reloaded.time('2026-09-11T18:00:00Z');
 assert.equal(reloaded.get('planner-dialog').open,false);
 assert.equal(reloaded.get('planner-count').textContent,'1/2 done');
 reloaded.time('2026-09-12T13:00:00Z');assert.equal(reloaded.get('planner-dialog').open,true);
 assert.equal(reloaded.get('planner-tasks').value,'');
});
test('Later dismisses for the day and manual editing remains available',()=>{
 const ui=harness();ui.time('2026-09-11T13:00:00Z');ui.get('planner-later').fire('click');
 ui.time('2026-09-11T15:00:00Z');assert.equal(ui.get('planner-dialog').open,false);
 ui.get('planner-edit').fire('click');assert.equal(ui.get('planner-dialog').open,true);
});

test('a second device shows the list planned on the first',async()=>{
 const server={day:'2026-09-11',prompted:true,revision:4,tasks:[{title:'Read chapter',done:true,priority:true},{title:'Take a walk',done:false,priority:false}]};
 const ui=harness();
 const calls=[];
 ui.window.PitchfordPlanner.init({request:async p=>{calls.push(p);return server;},hasPass:()=>true});
 await settle();
 assert.deepEqual(plain(calls),[{action:'read',day:'2026-09-11'}]);
 assert.equal(ui.get('planner-count').textContent,'1/2 done');
 assert.equal(ui.get('planner-list').children.length,2);
 // The first device already planned today, so the phone must not prompt again.
 assert.equal(ui.get('planner-dialog').open,false);
 assert.match(ui.get('planner-state').textContent,/Synced to your devices/);
 assert.equal(ui.get('planner-sync').hidden,true);
});

test('ticking a box sends a scoped toggle rather than replacing the list',async()=>{
 let server={day:'2026-09-11',prompted:true,revision:2,tasks:[{title:'Read chapter',done:false,priority:false}]};
 const ui=harness();const calls=[];
 ui.window.PitchfordPlanner.init({request:async p=>{calls.push(p);if(p.action==='toggle'){server={...server,revision:server.revision+1,tasks:server.tasks.map(t=>t.title===p.title?{...t,done:p.done}:t)};}return server;},hasPass:()=>true});
 await settle();
 const box=ui.get('planner-list').children[0].children[0].children[0];
 box.checked=true;box.fire('change');
 await settle();
 assert.deepEqual(plain(calls[1]),{action:'toggle',title:'Read chapter',done:true,day:'2026-09-11'});
 assert.equal(ui.get('planner-count').textContent,'1/1 done');
});

test('a failed sync keeps the local list and says so',async()=>{
 const ui=harness();const seen=[];
 ui.window.PitchfordPlanner.init({request:async p=>{seen.push(p);throw new Error('Worker unavailable');},hasPass:()=>true});
 await settle();
 ui.get('planner-edit').fire('click');
 ui.get('planner-tasks').value='Draft memo';
 ui.get('planner-form').fire('submit');
 await settle();
 assert.equal(ui.get('planner-count').textContent,'0/1 done');
 assert.match(ui.get('planner-state').textContent,/still saved on this device/);
 assert.equal(JSON.parse(ui.store.get('pitchford-daily-planner:2026-09-11')).tasks[0].title,'Draft memo');
});

test('a conflicting edit adopts the newer list instead of overwriting it',async()=>{
 const newer={day:'2026-09-11',prompted:true,revision:9,tasks:[{title:'Newer plan',done:false,priority:false}]};
 const ui=harness();
 ui.window.PitchfordPlanner.init({request:async p=>{if(p.action==='read')return {day:'2026-09-11',prompted:true,revision:1,tasks:[]};const failure=new Error('changed');failure.data={conflict:true,...newer};throw failure;},hasPass:()=>true});
 await settle();
 ui.get('planner-edit').fire('click');
 ui.get('planner-tasks').value='My plan';
 ui.get('planner-form').fire('submit');
 await settle();
 assert.deepEqual(plain(ui.get('planner-list').children.map(li=>li.children[0].children[1].textContent)),['Newer plan']);
 assert.match(ui.get('planner-state').textContent,/changed on another device/);
});

test('a locked browser still shows its own list and offers to sync',async()=>{
 const ui=harness();
 ui.window.PitchfordPlanner.init({request:async()=>{throw new Error('should not be called');},hasPass:()=>false});
 await settle();
 assert.equal(ui.get('planner-sync').hidden,false);
 assert.match(ui.get('planner-state').textContent,/Unlock to sync/);
});

test('a lapsed session is not re-prompted for the passphrase by background refreshes',async()=>{
 // hasPass() goes false when a 401 clears the session; the 30s refresh must not
 // reopen the passphrase dialog, but pressing Sync still may.
 const ui=harness();let unlocked=true;const calls=[];
 ui.window.PitchfordPlanner.init({request:async p=>{calls.push(p);return {day:'2026-09-11',prompted:true,revision:1,tasks:[]};},hasPass:()=>unlocked});
 await settle();
 assert.equal(calls.length,1);
 unlocked=false;
 ui.time('2026-09-11T13:30:00Z');await settle();
 ui.time('2026-09-11T14:00:00Z');await settle();
 assert.equal(calls.length,1);
 assert.match(ui.get('planner-state').textContent,/Unlock to sync/);
 ui.get('planner-sync').fire('click');await settle();
 assert.equal(calls.length,2);
});
