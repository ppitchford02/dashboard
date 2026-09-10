import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),core=require('../dashboard-core.js'),tz='America/New_York';
const lesson={title:'Class',kind:'class',due:'2026-09-10T18:30:00-04:00',end:'2026-09-10T20:00:00-04:00'};
test('day adapts before, during, and after class without inventing an event',()=>{
  for(const [time,phase] of [['17:00','prepare'],['18:30','class'],['19:59','class'],['20:00','reflect'],['21:31','reset']])assert.equal(core.nextMove([lesson],new Date('2026-09-10T'+time+':00-04:00'),tz).phase,phase);
  assert.equal(core.nextMove([],new Date('2026-09-11T10:00:00-04:00'),tz).item,null);
});
test('all user-facing clock labels use 12-hour time, including midnight and noon',()=>{
  assert.equal(core.clock('2026-09-10T17:58:00-04:00',tz),'5:58 PM');
  assert.equal(core.clock('2026-09-10T00:00:00-04:00',tz),'12:00 AM');
  assert.equal(core.clock('2026-09-10T12:00:00-04:00',tz),'12:00 PM');
  assert.equal(core.timeLabel('06:40 / 12:40 / 18:40'),'6:40 AM / 12:40 PM / 6:40 PM');
  assert.equal(core.timeLabel('5:58 PM'),'5:58 PM');
});
test('relative dates respect Akron midnight and daylight saving changes',()=>{
  assert.equal(core.dayKey('2026-09-11T02:00:00Z',tz),'2026-09-10');
  assert.equal(core.dayGap('2026-11-01T23:59:00-05:00','2026-10-31T23:00:00-04:00',tz),1);
  assert.equal(core.relativeDue('2026-09-09T23:59:00-04:00','2026-09-10T18:00:00-04:00',tz),'Yesterday at 11:59 PM');
});
test('expired deadline flags uncertainty rather than claiming a missed submission',()=>{
  const state=core.attentionState({related_deadlines:['Memo']},[{title:'Memo',due:'2026-09-09T23:59:00-04:00'}],'2026-09-10T18:00:00-04:00',tz);
  assert.equal(state.past,true);assert.equal(state.label,'Completion unconfirmed · Due Yesterday at 11:59 PM');
});
test('focus timer uses elapsed wall time and never goes negative',()=>{
  assert.equal(core.timerRemaining({running:true,endsAt:60000},45000),15);
  assert.equal(core.timerRemaining({running:true,endsAt:60000},70000),0);
  assert.equal(core.timerRemaining({running:false,remaining:123},999999),123);
});
