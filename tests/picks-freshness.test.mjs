/*
 * The freshness gate. The rule it locks down: the model is woken only for source
 * material no previous successful receipt already covered, and an abandoned pass
 * never consumes that material.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../picks-freshness.js');

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'picks-freshness-'));
}

const A = {sourceId:'s1', accountId:'acct-1', sourceUrl:'https://example.test/p/1', postedAt:'2026-09-16T12:00:00Z', contentHash:'h1'};
const B = {sourceId:'s2', accountId:'acct-2', sourceUrl:'https://example.test/p/2', postedAt:'2026-09-16T12:05:00Z', contentHash:'h2'};

test('a first pass releases everything and stops nothing', () => {
  const r = root();
  const d = gate.evaluate(r, [A, B]);
  assert.equal(d.stop, false);
  assert.equal(d.counts.fresh, 2);
  assert.deepEqual(d.fresh.map(f => f.candidate.sourceId), ['s1', 's2']);
});

test('a second pass over the same material stops without waking the model', () => {
  const r = root();
  const first = gate.evaluate(r, [A, B]);
  gate.commit(r, first.fresh, {completedAt:'2026-09-16T12:10:00Z'});
  const second = gate.evaluate(r, [A, B]);
  assert.equal(second.stop, true);
  assert.equal(second.counts.fresh, 0);
  assert.equal(second.counts.skipped, 2);
  assert.equal(second.lastReceiptCompletedAt, '2026-09-16T12:10:00Z');
});

test('one genuinely new post is released and the covered ones are not', () => {
  const r = root();
  const first = gate.evaluate(r, [A]);
  gate.commit(r, first.fresh, {completedAt:'2026-09-16T12:10:00Z'});
  const next = gate.evaluate(r, [A, B]);
  assert.equal(next.stop, false);
  assert.deepEqual(next.fresh.map(f => f.candidate.sourceId), ['s2']);
  assert.equal(next.skipped.length, 1);
});

test('a changed timestamp or a changed content hash is new material', () => {
  for (const change of [{postedAt:'2026-09-16T13:00:00Z'}, {contentHash:'h1-edited'}, {sourceUrl:'https://example.test/p/1?x=1'}]) {
    const r = root();
    const first = gate.evaluate(r, [A]);
    gate.commit(r, first.fresh, {completedAt:'t'});
    const next = gate.evaluate(r, [{...A, ...change}]);
    assert.equal(next.stop, false, JSON.stringify(change));
  }
});

test('the same post arriving twice in one batch is interpreted once', () => {
  const r = root();
  const d = gate.evaluate(r, [A, {...A}, B]);
  assert.equal(d.counts.fresh, 2);
  assert.equal(d.skipped[0].reason, 'duplicate within this batch');
});

test('an abandoned pass does not consume its material', () => {
  const r = root();
  const first = gate.evaluate(r, [A, B]);
  assert.equal(first.counts.fresh, 2);
  // No commit: the receipt was never written.
  const retry = gate.evaluate(r, [A, B]);
  assert.equal(retry.stop, false);
  assert.equal(retry.counts.fresh, 2);
});

test('the fresh candidates are the caller objects untouched, so the exact link survives', () => {
  const r = root();
  const d = gate.evaluate(r, [A]);
  assert.equal(d.fresh[0].candidate.sourceUrl, A.sourceUrl);
  assert.deepEqual(d.fresh[0].candidate, A);
});

test('the seen index stores no creator link, handle or account URL', () => {
  const r = root();
  const first = gate.evaluate(r, [A, B]);
  gate.commit(r, first.fresh, {completedAt:'t'});
  const text = fs.readFileSync(gate.seenPath(r), 'utf8');
  assert.equal(text.includes('example.test'), false);
  assert.equal(text.includes('https://'), false);
  assert.equal(text.includes('/p/1'), false);
});

test('a corrupt or foreign index is treated as empty rather than trusted', () => {
  const r = root();
  fs.mkdirSync(path.join(r, 'agent-health'), {recursive:true});
  fs.writeFileSync(gate.seenPath(r), 'not json at all');
  assert.equal(gate.evaluate(r, [A]).counts.fresh, 1);
  fs.writeFileSync(gate.seenPath(r), JSON.stringify({version:99, entries:{}}));
  assert.equal(gate.evaluate(r, [A]).counts.fresh, 1);
});

test('the zero-result receipt is a real aggregate receipt with zero picks', () => {
  const receipt = gate.zeroReceipt({startedAt:'2026-09-16T12:00:00Z', accountsChecked:11, accountsBlocked:0});
  assert.equal(receipt.outcome, 'no_work');
  assert.equal(receipt.picksSaved, 0);
  assert.equal(receipt.accountsChecked, 11);
  assert.equal(receipt.startedAt, '2026-09-16T12:00:00Z');
  assert.match(receipt.note, /no model interpretation was run/i);
  for (const key of ['outcome','accountsChecked','accountsBlocked','picksSaved','checksSaved','note','startedAt']) {
    assert.ok(key in receipt, key);
  }
});

test('an empty candidate list stops the pass', () => {
  assert.equal(gate.evaluate(root(), []).stop, true);
  assert.equal(gate.evaluate(root(), undefined).stop, true);
});

test('the gate module opens no network connection and calls no model', () => {
  const text = fs.readFileSync(new URL('../picks-freshness.js', import.meta.url), 'utf8');
  for (const forbidden of ['fetch(', 'https.request', 'node:http', 'child_process', 'anthropic', 'firecrawl']) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});
