(function(root){
  'use strict';
  function dayKey(date,tz){return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));}
  function clock(date,tz){return new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',minute:'2-digit',hour12:true}).format(new Date(date));}
  function dayGap(date,now,tz){return Math.round((Date.parse(dayKey(date,tz)+'T12:00:00Z')-Date.parse(dayKey(now,tz)+'T12:00:00Z'))/86400000);}
  function relativeDue(date,now,tz){const gap=dayGap(date,now,tz);return (gap===0?'Today':gap===1?'Tomorrow':gap===-1?'Yesterday':new Intl.DateTimeFormat('en-US',{timeZone:tz,month:'short',day:'numeric'}).format(new Date(date)))+' at '+clock(date,tz);}
  function timeLabel(text){return String(text||'').replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[AP]M\b)/gi,(_,h,m)=>(Number(h)%12||12)+':'+m+' '+(Number(h)>=12?'PM':'AM'));}
  function nextMove(deadlines,now,tz){
    const t=+new Date(now),items=[...deadlines].sort((a,b)=>Date.parse(a.due)-Date.parse(b.due));
    const active=items.find(x=>x.kind==='class'&&Date.parse(x.due)<=t&&Date.parse(x.end||x.due)>t);
    if(active)return {phase:'class',item:active};
    const recent=items.filter(x=>x.kind==='class'&&x.end&&t>=Date.parse(x.end)&&t-Date.parse(x.end)<90*60000).pop();
    if(recent)return {phase:'reflect',item:recent};
    const next=items.find(x=>Date.parse(x.due)>t);
    if(next&&next.kind==='class'&&Date.parse(next.due)-t<=90*60000)return {phase:'prepare',item:next};
    const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(new Date(now)));
    return {phase:hour>=20||hour<5?'reset':'plan',item:next||null};
  }
  function attentionState(item,deadlines,now,tz){
    const refs=Array.isArray(item.related_deadlines)?item.related_deadlines:[];
    const linked=deadlines.filter(d=>refs.includes(d.title));
    const due=item.due||linked.map(d=>d.due).sort()[0];
    if(!due||isNaN(Date.parse(due)))return {label:timeLabel(item.when)||'Review when ready',past:false,linked:false};
    const past=Date.parse(due)<+new Date(now);
    return {label:(past?'Completion unconfirmed · Due ':'Due ')+relativeDue(due,now,tz),past,linked:true};
  }
  function timerRemaining(timer,now){return Math.max(0,Math.ceil(timer.running?(timer.endsAt-now)/1000:timer.remaining));}
  const api={dayKey,clock,dayGap,relativeDue,timeLabel,nextMove,attentionState,timerRemaining};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.DashboardCore=api;
})(globalThis);
