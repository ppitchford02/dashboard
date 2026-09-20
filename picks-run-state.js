'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./picks-freshness.js');

function file(root) { return path.join(root, 'agent-health', 'sports-picks-active-run.json'); }
function read(root) {
  try { return JSON.parse(fs.readFileSync(file(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function write(root, state) {
  const target = file(root), tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), {recursive:true, mode:0o700});
  fs.writeFileSync(tmp, JSON.stringify(state), {mode:0o600});
  fs.renameSync(tmp, target);
  return state;
}
function start(root, startedAt, released) {
  if (!Number.isFinite(Date.parse(startedAt))) throw Error('A valid startedAt is required.');
  const old = read(root);
  if (old && !old.closed && old.startedAt !== startedAt) throw Error('An unfinished run exists. Resume with startedAt '+old.startedAt+' before starting another.');
  const state = old && old.startedAt === startedAt ? old : {startedAt, released:[], resolutions:{}, closed:false};
  if (state.closed) throw Error('This run already has a receipt. Use a new startedAt.');
  const items = new Map(state.released.map(item => [item.fingerprint, item]));
  for (const item of released) items.set(item.fingerprint, item);
  state.released = [...items.values()];
  return write(root, state);
}
function resolve(root, args) {
  const state = read(root);
  if (!state || state.closed || state.startedAt !== args.startedAt) throw Error('No matching active run. Call freshness first.');
  const key = fingerprint(args);
  if (!state.released.some(item => item.fingerprint === key)) throw Error('Post was not released by this run.');
  if (!['resolved','excluded','unresolved'].includes(args.status)) throw Error('Choose resolved, excluded, or unresolved.');
  if (!args.reason?.trim() || !Array.isArray(args.attempts) || !args.attempts.length || args.attempts.some(a => !a?.trim())) throw Error('Record actual evidence attempts and their result.');
  if (args.status === 'resolved' && args.allSelectionsHandled !== true) throw Error('Resolved requires every selection to be handled; partial capture stays unresolved.');
  state.resolutions[key] = {status:args.status, reason:args.reason, attempts:args.attempts, allSelectionsHandled:args.allSelectionsHandled === true};
  write(root,state);
  return state.resolutions[key];
}
function summarize(state) {
  const completed = [], pending = [];
  for (const item of state.released) {
    const resolution = state.resolutions[item.fingerprint];
    if (resolution && ['resolved','excluded'].includes(resolution.status)) completed.push(item);
    else pending.push({...item, resolution:resolution || {status:'unresolved', reason:'No per-post evidence result recorded.'}});
  }
  return {completed,pending};
}
function savedSince(desk, startedAt) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) throw Error('Invalid run start.');
  return (desk.picks || []).filter(p => Number.isFinite(Date.parse(p.createdAt)) && Date.parse(p.createdAt) >= start);
}
module.exports = {read,write,start,resolve,summarize,savedSince};
