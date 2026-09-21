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
  if (old?.closed && old.startedAt !== startedAt) {
    const today = easternDay(startedAt);
    const pending = summarize(old).pending;
    const retained = pending.filter(item => easternDay(old.startedAt) === today || String(item.candidate?.eventDate || '') >= today);
    state.deferred = [...(old.deferred || []), ...pending.filter(item => !retained.includes(item))];
    state.released = retained;
    state.recoveryFrom = old.startedAt;
    state.resolutions = Object.fromEntries(state.released.filter(item => old.resolutions[item.fingerprint]).map(item => [item.fingerprint,old.resolutions[item.fingerprint]]));
  }
  const items = new Map(state.released.map(item => [item.fingerprint, item]));
  const currentFingerprints = new Set();
  for (const item of released) {
    currentFingerprints.add(item.fingerprint);
    const previous = items.get(item.fingerprint);
    items.set(item.fingerprint, {...previous,...item,firstSeenAt:previous?.firstSeenAt || startedAt,lastSeenAt:startedAt});
  }
  // New inventory comes before retries, so a backlog cannot starve discovery.
  const freshKeys = new Set(released.map(item => item.fingerprint));
  state.released = [...items.values()].sort((a,b) => Number(freshKeys.has(b.fingerprint)) - Number(freshKeys.has(a.fingerprint)));
  state.currentFingerprints = [...currentFingerprints];
  return write(root, state);
}
function easternDay(value) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
}
function checkpoint(root, args) {
  const state = start(root,args.startedAt,[]);
  state.inventory = state.inventory || {};
  if (args.accountId) {
    if (!args.sourceId || !['checked','blocked'].includes(args.status)) throw Error('Account checkpoint needs sourceId and checked/blocked status.');
    const candidates = args.candidates || [];
    if (candidates.some(c => c.accountId !== args.accountId || c.sourceId !== args.sourceId || !c.sourceUrl)) throw Error('Checkpoint candidates must belong to this account.');
    state.inventory[args.accountId] = {sourceId:args.sourceId,status:args.status,candidates,reason:args.reason || '',observedAt:new Date().toISOString()};
  }
  return write(root,state);
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
function summarizeCurrent(state) {
  const all = summarize(state);
  const current = new Set(state.currentFingerprints || []);
  const today = easternDay(state.startedAt);
  const applies = item => current.has(item.fingerprint) || String(item.candidate?.eventDate || '') >= today;
  return {completed:all.completed.filter(applies),pending:all.pending.filter(applies)};
}
function savedSince(desk, startedAt) {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) throw Error('Invalid run start.');
  return (desk.picks || []).filter(p => Number.isFinite(Date.parse(p.createdAt)) && Date.parse(p.createdAt) >= start);
}
module.exports = {read,write,start,checkpoint,resolve,summarize,summarizeCurrent,savedSince};
