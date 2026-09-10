import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../worker.js',import.meta.url),'utf8');
const {runTool,default:worker}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
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
