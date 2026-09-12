/* Today's list is private, but it follows Preston between devices: it is stored
   in the Worker's private D1 database, never in data.json or the public page.
   localStorage is kept only as an offline cache so the list paints immediately
   and still works when the Worker or the network is unavailable. */
(() => {
  const $ = id => document.getElementById(id);
  const dialog = $('planner-dialog');
  const prefix = 'pitchford-daily-planner:';
  const memory = new Map();
  const copy = value => JSON.parse(JSON.stringify(value));
  const clock = () => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', hourCycle:'h23'}).formatToParts(new Date()).map(p => [p.type,p.value]));
    return {day:`${p.year}-${p.month}-${p.day}`, hour:Number(p.hour)};
  };
  let day = clock().day;
  let api = null;          // {request, hasPass} supplied by the dashboard
  let synced = false;      // server state loaded for `day` in this session
  let pending = false;     // a request is in flight
  let note = '';           // transient status, outranks the standing message

  function normalise(value) {
    const tasks = [], seen = new Set();
    for (const t of Array.isArray(value?.tasks) ? value.tasks : []) {
      if (!t || typeof t.title !== 'string') continue;
      const title = t.title.trim(), key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      tasks.push({title, done:t.done === true, priority:t.priority === true});
    }
    return {prompted:value?.prompted === true, revision:Number.isInteger(value?.revision) ? value.revision : 0, tasks};
  }

  function warn() { note = 'Browser storage is unavailable. Keep this page open to keep your list.'; }
  function read(key) {
    let raw;
    try { raw = localStorage.getItem(prefix+key); } catch { warn(); }
    try { return normalise(JSON.parse(raw || 'null') || memory.get(key)); }
    catch { return normalise(null); }
  }
  let state = read(day);
  function save() {
    memory.set(day, state);
    try { localStorage.setItem(prefix+day, JSON.stringify(state)); } catch { warn(); }
  }

  function status() {
    const sync = $('planner-sync');
    if (sync) sync.hidden = !api || synced;
    if (note) { $('planner-state').textContent = note; return; }
    if (!api) $('planner-state').textContent = 'Private to this browser · morning check-in at 9 AM Eastern.';
    else if (pending) $('planner-state').textContent = 'Syncing today’s list…';
    else if (synced) $('planner-state').textContent = 'Synced to your devices · morning check-in at 9 AM Eastern.';
    else $('planner-state').textContent = 'Showing this device’s copy. Unlock to sync today’s list across your devices.';
  }

  function render() {
    $('planner-count').textContent = `${state.tasks.filter(t=>t.done).length}/${state.tasks.length} done`;
    $('planner-list').replaceChildren();
    $('planner-empty').hidden = state.tasks.length > 0;
    state.tasks.forEach(task => {
      const li = document.createElement('li'), label = document.createElement('label'), box = document.createElement('input'), title = document.createElement('span');
      box.type = 'checkbox'; box.checked = task.done; box.disabled = pending;
      title.textContent = task.title;
      if(task.done) title.className = 'planner-done';
      label.append(box,title);
      if(task.priority) { const badge = document.createElement('small'); badge.textContent = 'Priority'; label.append(badge); }
      box.addEventListener('change', () => {
        if(clock().day !== day) { check(); return; }
        toggle(task.title, box.checked);
      });
      li.append(label); $('planner-list').append(li);
    });
    status();
  }

  function adopt(data) { state = normalise(data); synced = true; save(); }

  // Every server call funnels through here so a failure always leaves the local
  // copy intact and says so, rather than silently dropping an edit.
  // Returns the server state, 'conflict' when the newer list was adopted, or
  // null when nothing reached the Worker.
  async function send(payload, failure) {
    if (!api) return null;
    pending = true; note = ''; render();
    try {
      const data = await api.request({...payload, day});
      if (!data) { note = 'Today’s list was not synced. It is still saved on this device.'; return null; }
      adopt(data);
      return data;
    } catch (error) {
      if (error?.data?.conflict) {
        adopt(error.data);
        note = 'Today’s list had changed on another device, so the newer list is shown.';
        return 'conflict';
      }
      note = `${failure} It is still saved on this device.`;
      return null;
    } finally {
      pending = false; render();
    }
  }

  // `ask` is true only for a deliberate press of Sync. Background refreshes must
  // never raise the passphrase dialog, or a lapsed session would reopen it every
  // thirty seconds.
  async function sync(ask = false) {
    if (!api || pending) return;
    if (!ask && !api.hasPass()) { synced = false; render(); return; }
    await send({action:'read'}, 'Could not load today’s list.');
    if (synced) maybePrompt();
  }

  async function toggle(title, done) {
    const previous = copy(state);
    const target = state.tasks.find(t => t.title.toLowerCase() === title.toLowerCase());
    if (target) target.done = done;   // optimistic: the box is already ticked
    save(); render();
    if (!api) return;
    if (await send({action:'toggle', title, done}, 'Could not sync that change.') === null) {
      state = previous; save(); render();
    }
  }

  function open() {
    if(dialog.open) return;
    day = clock().day;
    $('planner-tasks').value = state.tasks.filter(t=>!t.priority).map(t=>t.title).join('\n');
    $('planner-priorities').value = state.tasks.filter(t=>t.priority).map(t=>t.title).join('\n');
    dialog.showModal();
    state.prompted = true; save(); render();
    // Records the check-in for every device without touching the task list.
    if (api && api.hasPass()) send({action:'prompted'}, 'Could not sync today’s check-in.');
  }

  $('planner-edit').addEventListener('click', () => open());
  $('planner-later').addEventListener('click', () => dialog.close());
  if ($('planner-sync')) $('planner-sync').addEventListener('click', () => sync(true));

  $('planner-form').addEventListener('submit', event => {
    event.preventDefault();
    const old = state.tasks;
    day = clock().day;
    const tasks = [], seen = new Set();
    for(const [id,priority] of [['planner-priorities',true],['planner-tasks',false]]) {
      for(const line of $(id).value.split('\n')) {
        const title = line.trim(), key = title.toLowerCase();
        if(!title || seen.has(key)) continue;
        seen.add(key);
        tasks.push({title,priority,done:old.find(t=>t.title.toLowerCase()===key)?.done || false});
      }
    }
    const revision = state.revision;
    state = {prompted:true, revision, tasks};
    save(); render(); dialog.close();
    if (api) send({action:'save', tasks, revision}, 'Could not sync today’s plan.');
  });

  function maybePrompt() {
    if (dialog.open || state.prompted) return;
    const now = clock();
    if (!document.hidden && now.hour >= 9 && !document.querySelector('dialog[open]') && !document.activeElement?.matches('input,textarea,select')) open();
  }

  function check() {
    // Do not interrupt another dialog, an active form, or a planner draft at midnight.
    if(dialog.open) return;
    const now = clock();
    if (now.day !== day) { day = now.day; state = read(day); synced = false; note = ''; }
    render();
    // With the Worker the check-in waits for the shared list, so planning on the
    // Mac does not prompt again on the phone. Without it, this device decides.
    if (api) { if (!document.hidden) sync(); }
    else maybePrompt();
  }

  window.addEventListener('storage', event => { if(event.key?.startsWith(prefix) && !dialog.open) { state = read(day); render(); } });
  document.addEventListener('visibilitychange', check);
  setInterval(check,30000);
  render();

  window.PitchfordPlanner = {
    init(provided) {
      api = provided;
      // The local cache may be empty on this device while the shared day is
      // already planned elsewhere. Wait for a server read before checking in.
      if (api.hasPass()) sync(); else render();
    },
  };
})();
