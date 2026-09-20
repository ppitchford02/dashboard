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

const VERSION = 2;

function seenPath(root) {
  return path.join(root || __dirname, 'agent-health', 'sports-picks-seen.json');
}

/** Instagram shortcode from /p/, /reel/, /tv/, or /{user}/reel|p|tv/. */
function instagramShortcode(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (['p', 'reel', 'tv'].includes(parts[i].toLowerCase())) return parts[i + 1];
  }
  return '';
}

/** Remove tracking noise without changing parameters that identify the post. */
function normalizeSourceUrl(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || ['igsh', 'igshid', '_r', '_t', 's', 'si', 'ref', 'tracking'].includes(lower)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const igHost = ['insta', 'gram.', 'com'].join('');
    if (host === igHost || host === 'instagr.am') {
      const code = instagramShortcode(url.pathname);
      if (code) return `https://www.${igHost}/p/${code}`;
    }
    return url.toString();
  } catch { return raw; }
}

/**
 * Stable identity for one source post. Listing timestamps and visible metadata
 * can change between runs; the post's own URL cannot. Hash only; no link is kept.
 */
function fingerprint(candidate) {
  const c = candidate || {};
  const parts = [
    String(c.accountId || '').trim().toLowerCase(),
    String(c.sourceId || '').trim().toLowerCase(),
    normalizeSourceUrl(c.sourceUrl),
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
  if (!data || typeof data.entries !== 'object' || data.entries === null) return emptyIndex();
  if (data.version === 1) {
    return { version: 1, updatedAt: data.updatedAt || '', lastReceiptCompletedAt: data.lastReceiptCompletedAt || '', entries: {} };
  }
  if (data.version !== VERSION) return emptyIndex();
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
function partition(candidates, index, covered = []) {
  const entries = (index || emptyIndex()).entries || {};
  const known = new Set(Object.keys(entries));
  for (const item of Array.isArray(covered) ? covered : []) {
    // One saved selection does not prove a multi-pick post was fully read.
    if (item && item.sourceUrl && item.coverageComplete === true) known.add(fingerprint(item));
  }
  const fresh = [];
  const skipped = [];
  const coverage = [];
  const batch = new Set();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const fp = fingerprint(candidate);
    if (known.has(fp)) { skipped.push({ fingerprint: fp, reason: 'covered by an earlier successful receipt or saved desk record' }); continue; }
    if (batch.has(fp)) { skipped.push({ fingerprint: fp, reason: 'duplicate within this batch' }); continue; }
    batch.add(fp);
    const item = { fingerprint: fp, candidate };
    coverage.push(item);
    fresh.push(item);
  }
  return { fresh, skipped, coverage };
}

/**
 * Advance the index. Called only after a successful aggregate receipt, so an
 * abandoned or failed pass never marks material as already interpreted.
 */
function commit(root, fresh, receipt) {
  const previous = readSeen(root);
  if (!['complete', 'no_work'].includes(receipt?.outcome)) return previous;
  const index = previous.version === VERSION ? previous : {
    ...emptyIndex(),
    lastReceiptCompletedAt: previous.lastReceiptCompletedAt || '',
  };
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
    outcome: i.accountsBlocked > 0 ? 'blocked' : 'no_work',
    accountsChecked: Number.isInteger(i.accountsChecked) ? i.accountsChecked : 0,
    accountsBlocked: Number.isInteger(i.accountsBlocked) ? i.accountsBlocked : 0,
    picksSaved: 0,
    checksSaved: Number.isInteger(i.checksSaved) ? i.checksSaved : 0,
    startedAt: String(i.startedAt || new Date().toISOString()),
    note: i.note || 'Freshness gate: no source material that a previous successful receipt had not already covered. No model interpretation was run.',
  };
}

/** The whole decision, without any side effect. */
function evaluate(root, candidates, covered = []) {
  const index = readSeen(root);
  const { fresh, skipped, coverage } = partition(candidates, index, covered);
  return {
    stop: fresh.length === 0,
    fresh,
    skipped,
    coverage,
    counts: { candidates: Array.isArray(candidates) ? candidates.length : 0, fresh: fresh.length, skipped: skipped.length },
    lastReceiptCompletedAt: index.lastReceiptCompletedAt,
  };
}

module.exports = { VERSION, seenPath, normalizeSourceUrl, instagramShortcode, fingerprint, emptyIndex, readSeen, writeSeen, partition, commit, zeroReceipt, evaluate };
