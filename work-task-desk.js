/* Private mirror only. No task data is embedded in the public build or cached.
   Completing tasks stays in the evidence-linked local queue, not a checkbox. */
(() => {
  const host = document.getElementById('work-task-list');
  if (!host) return;
  const state = document.getElementById('work-task-state');
  const refresh = document.getElementById('work-task-refresh');
  let api = null, pending = false;
  const node = (tag, content) => {
    const e = document.createElement(tag); e.textContent = content; return e;
  };
  const safeUrl = value => {
    try {
      const u = new URL(value);
      return ['https:', 'codex:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
    } catch { return null; }
  };
  async function load() {
    if (!api || pending) return;
    pending = true; refresh.disabled = true;
    state.textContent = 'Loading private task snapshot…';
    try {
      const data = await api.request({action:'read'});
      if (!data) { state.textContent = 'Unlock to load shared tasks.'; return; }
      if (!Array.isArray(data.tasks)) throw new Error('Invalid task snapshot');
      host.replaceChildren();
      const tasks = data.tasks.filter(t => !['done','cancelled'].includes(t.status));
      tasks.sort((a,b) => (a.due || '9999').localeCompare(b.due || '9999'));
      for (const task of tasks) {
        const card = document.createElement('li');
        card.append(node('h3', task.title), node('p', `${task.project} · ${task.owner} · ${task.status}`));
        if (task.due) {
          const overdue = Date.parse(task.due) < Date.now();
          const due = node('p', `${overdue ? 'Overdue · ' : 'Due · '}${task.due}`);
          if (overdue) due.className = 'error';
          card.append(due);
        }
        if (task.waiting_on || task.reason) card.append(node('p', `Waiting / blocker: ${task.waiting_on || ''} ${task.reason || ''}`));
        const url = safeUrl(task.source);
        if (url) {
          const link = node('a', 'Original request ↗'); link.href = url;
          link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
        } else card.append(node('p', `Protected local source: ${task.source}`));
        const receipt = task.completion_receipt;
        card.append(node('p', receipt ? `Recorded review: ${receipt.verdict} · ${receipt.reviewer} · ${receipt.at}` : 'No completion review recorded.'));
        host.append(card);
      }
      state.textContent = data.synced_at
        ? `Snapshot synced ${data.synced_at}. ${tasks.length} open ${tasks.length === 1 ? 'task' : 'tasks'}. Not a live inbox scan.`
        : 'No shared snapshot has been synced. This does not mean there are no outstanding requests.';
    } catch {
      state.textContent = 'Shared tasks could not be refreshed. Any displayed snapshot is stale; the private local queue is unchanged.';
    } finally { pending = false; refresh.disabled = false; }
  }
  refresh.addEventListener('click', load);
  // Poll only the private mirror, while this tab is visible and already unlocked.
  // Never open a password prompt or invoke a model from an automatic refresh.
  const autoLoad = () => { if (api?.hasPass() && !document.hidden) return load(); };
  if (typeof window.setInterval === 'function') window.setInterval(autoLoad, 60000);
  if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', autoLoad);
  if (typeof window.addEventListener === 'function') window.addEventListener('focus', autoLoad);
  window.PitchfordWorkTasks = {init(provided) { api = provided; if (api.hasPass()) load(); }};
})();
