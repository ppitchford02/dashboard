/*
 * Deterministic freshness gate for the scheduled Sports Picks pass.
 *
 * Every pass woke the model to read the same posts it read last time. Deciding
 * whether a post is new is not interpretation: it is a comparison of source
 * identifiers, links, timestamps and content hashes against what the last
 * successful aggregate receipt already covered.
 *
 * This module is pure. It opens no network connection, checks no source, calls
 * no model, and reads and writes exactly one local file. The seen index stores
 * hashes, never creator links, so nothing here can leak an account URL into a
 * file or a report. The fresh candidates handed back are the caller's own
 * objects untouched, so the exact post link survives for reopening.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = 1;

function seenPath(root) {
  return path.join(root || __dirname, 'agent-health', 'sports-picks-seen.json');
}

/** A stable identity for one piece of source material. Hash only; no link is kept. */
function fingerprint(candidate) {
  const c = candidate || {};
  const parts = [
    String(c.accountId || '').trim().toLowerCase(),
    String(c.sourceId || '').trim().toLowerCase(),
    String(c.sourceUrl || '').trim(),
    String(c.postedAt || '').trim(),
    String(c.contentHash || '').trim(),
  ];
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function emptyIndex() {
  return { version: VERSION, updatedAt: '', lastReceiptCompletedAt: '', entries: {} };
}

function readSeen(root) {
  let data;
  try { data = JSON.parse(fs.readFileSync(seenPath(root), 'utf8')); }
  catch { return emptyIndex(); }
  if (!data || data.version !== VERSION || typeof data.entries !== 'object' || data.entries === null) return emptyIndex();
  return { version: VERSION, updatedAt: data.updatedAt || '', lastReceiptCompletedAt: data.lastReceiptCompletedAt || '', entries: data.entries };
}

function writeSeen(root, index) {
  const target = seenPath(root);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

/**
 * Split candidates into what the model has never been shown and what it has.
 * Duplicates inside one batch collapse to the first occurrence, so the same post
 * arriving from two accounts' feeds is interpreted once.
 */
function partition(candidates, index) {
  const entries = (index || emptyIndex()).entries || {};
  const fresh = [];
  const skipped = [];
  const batch = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const fp = fingerprint(candidate);
    if (entries[fp]) { skipped.push({ fingerprint: fp, reason: 'covered by an earlier successful receipt' }); continue; }
    if (batch.has(fp)) { skipped.push({ fingerprint: fp, reason: 'duplicate within this batch' }); continue; }
    batch.add(fp);
    fresh.push({ fingerprint: fp, candidate });
  }
  return { fresh, skipped };
}

/**
 * Advance the index. Called only after a successful aggregate receipt, so an
 * abandoned or failed pass never marks material as already interpreted.
 */
function commit(root, fresh, receipt) {
  const index = readSeen(root);
  const at = new Date().toISOString();
  for (const item of fresh || []) {
    if (index.entries[item.fingerprint]) continue;
    index.entries[item.fingerprint] = {
      accountId: String(item.candidate?.accountId || ''),
      postedAt: String(item.candidate?.postedAt || ''),
      firstSeenAt: at,
    };
  }
  index.updatedAt = at;
  index.lastReceiptCompletedAt = String(receipt?.completedAt || receipt?.startedAt || at);
  writeSeen(root, index);
  return index;
}

/** The receipt a pass writes when the gate found nothing new. */
function zeroReceipt(input) {
  const i = input || {};
  return {
    outcome: 'no_work',
    accountsChecked: Number.isInteger(i.accountsChecked) ? i.accountsChecked : 0,
    accountsBlocked: Number.isInteger(i.accountsBlocked) ? i.accountsBlocked : 0,
    picksSaved: 0,
    checksSaved: Number.isInteger(i.checksSaved) ? i.checksSaved : 0,
    startedAt: String(i.startedAt || new Date().toISOString()),
    note: i.note || 'Freshness gate: no source material that a previous successful receipt had not already covered. No model interpretation was run.',
  };
}

/** The whole decision, without any side effect. */
function evaluate(root, candidates) {
  const index = readSeen(root);
  const { fresh, skipped } = partition(candidates, index);
  return {
    stop: fresh.length === 0,
    fresh,
    skipped,
    counts: { candidates: Array.isArray(candidates) ? candidates.length : 0, fresh: fresh.length, skipped: skipped.length },
    lastReceiptCompletedAt: index.lastReceiptCompletedAt,
  };
}

module.exports = { VERSION, seenPath, fingerprint, emptyIndex, readSeen, writeSeen, partition, commit, zeroReceipt, evaluate };
