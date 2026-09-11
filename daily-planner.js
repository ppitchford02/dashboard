/* Daily planning is private to this browser; nothing is sent to the server. */
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('planner-dialog');
  const prefix = 'pitchford-daily-planner:';
  const memory = new Map();
  const clock = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'}).formatToParts(new Date()).map(p => [p.type,p.value]));
    return {day:`${p.year}-${p.month}-${p.day}`, hour:Number(p.hour)};
  };
  let day = clock().day;
  function warn() { $('planner-state').textContent = 'Browser storage is unavailable. Keep this page open to keep your list.'; }
  function read(key) {
    let raw;
    try { raw = localStorage.getItem(prefix+key); } catch { warn(); }
    try {
      const value = JSON.parse(raw || 'null') || memory.get(key);
      return {prompted:value?.prompted === true, tasks:Array.isArray(value?.tasks) ? value.tasks.filter(t => t && typeof t.title === 'string').map(t => ({title:t.title, done:t.done === true, priority:t.priority === true})) : []};
    } catch { return {prompted:false,tasks:[]}; }
  }
  let state = read(day);
  function save() {
    memory.set(day,state);
    try { localStorage.setItem(prefix+day,JSON.stringify(state)); } catch { warn(); }
  }
  function render() {
    $('planner-count').textContent = `${state.tasks.filter(t=>t.done).length}/${state.tasks.length} done`;
    $('planner-list').replaceChildren();
    $('planner-empty').hidden = state.tasks.length > 0;
    state.tasks.forEach(task => {
      const li = document.createElement('li'), label = document.createElement('label'), box = document.createElement('input'), title = document.createElement('span');
      box.type = 'checkbox'; box.checked = task.done;
      title.textContent = task.title;
      if(task.done) title.className = 'planner-done';
      label.append(box,title);
      if(task.priority) { const badge = document.createElement('small'); badge.textContent = 'Priority'; label.append(badge); }
      box.addEventListener('change', () => {
        if(clock().day !== day) { check(); return; }
        state = read(day);
        const current = state.tasks.find(t=>t.title.toLowerCase()===task.title.toLowerCase());
        if(current) current.done = box.checked;
        save(); render();
      });
      li.append(label); $('planner-list').append(li);
    });
  }
  function open() {
    if(dialog.open) return;
    day = clock().day; state = read(day);
    $('planner-tasks').value = state.tasks.filter(t=>!t.priority).map(t=>t.title).join('\n');
    $('planner-priorities').value = state.tasks.filter(t=>t.priority).map(t=>t.title).join('\n');
    dialog.showModal();
    state.prompted = true; save(); render();
  }
  $('planner-edit').addEventListener('click', open);
  $('planner-later').addEventListener('click', () => dialog.close());
  $('planner-form').addEventListener('submit', event => {
    event.preventDefault();
    const old = state.tasks;
    day = clock().day; state = read(day);
    const tasks = [], seen = new Set();
    for(const [id,priority] of [['planner-priorities',true],['planner-tasks',false]]) {
      for(const line of $(id).value.split('\n')) {
        const title = line.trim(), key = title.toLowerCase();
        if(!title || seen.has(key)) continue;
        seen.add(key);
        tasks.push({title,priority,done:old.find(t=>t.title.toLowerCase()===key)?.done || false});
      }
    }
    state = {prompted:true,tasks}; save(); render(); dialog.close();
  });
  function check() {
    // Do not interrupt another dialog, an active form, or a planner draft at midnight.
    if(dialog.open) return;
    const now = clock(); day = now.day; state = read(day); render();
    if(!document.hidden && now.hour >= 9 && !state.prompted && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input,textarea,select')) open();
  }
  window.addEventListener('storage', event => { if(event.key?.startsWith(prefix) && !dialog.open) check(); });
  document.addEventListener('visibilitychange', check);
  setInterval(check,30000);
  render(); check();
})();
