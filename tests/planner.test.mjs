import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../daily-planner.js',import.meta.url),'utf8');
function harness(store=new Map()) {
  let now='2026-09-11T12:59:00Z', tick;
  class Element {
    constructor(){this.children=[];this.listeners={};this.value='';this.open=false;}
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
  vm.runInNewContext(script,{document,window:{addEventListener(){}},localStorage:{getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)},Map,Set,Intl,Date:Clock,setInterval:fn=>{tick=fn;}});
  return {get,store,time:value=>{now=value;tick();}};
}
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
