import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../parlay-builder.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, Intl, Date });
vm.runInContext(script, context);
const builder = context.window.PitchfordParlay;
builder.setRoster([{id: 'danny'}, {id: 'stunad'}, {id: 'nick'}, {id: 'cru'}, {id: 'sbd'}, {id: 'bat'}].map(creator => ({...creator, name: creator.id, accounts: []})));

test('builder only forwards confirmed, dated anytime touchdown records from saved sources', () => {
  const base = { eventStartAt:'2099-09-13T23:00:00Z', eventTimeSource:'https://example.com/schedule', sourceId: 'cru', sport: 'NFL', eventDate: '2026-09-13', status: 'pending', archived: false,
    capturedBeforeStart: true, selection: 'Jahmyr Gibbs 1+ TD', market: 'Player prop',
    event: 'Saints at Lions', sourceUrl: 'https://example.com/channels/example', originalText: 'Anytime touchdown: Jahmyr Gibbs' };
  const picks = [base,
    { ...base, sourceId: 'danny', selection: 'Jalen Hurts touchdown' },
    { ...base, sourceId: 'nick', selection: 'Lamar Jackson passing touchdowns' },
    { ...base, sourceId: 'stunad', eventDate: '2026-09-12' },
    { ...base, sourceId: 'sbd', status: 'review' },
    { ...base, sourceId: 'bat', sourceUrl: '' },
    { ...base, sourceId: 'unknown' }];
  const verified = builder.verifiedTouchdowns(picks, '2026-09-13');
  assert.equal(verified.length, 2);
  const question = builder.questionFor('2026-09-13', verified);
  assert.match(question, /Jahmyr Gibbs/);
  assert.match(question, /Jalen Hurts/);
  assert.doesNotMatch(question, /Lamar Jackson/);
  assert.doesNotMatch(question, /Anytime touchdown: Jahmyr Gibbs/);
  assert.doesNotMatch(question, /discord\.com/);
  assert.ok(question.length < 2000);
});

test('builder uses the Eastern game date and reports missing creator records without inventing matches', () => {
  assert.equal(builder.easternDate(new Date('2026-09-13T03:30:00Z')), '2026-09-12');
  assert.equal(builder.easternDate(new Date('2026-09-13T16:00:00Z')), '2026-09-13');
  assert.match(builder.questionFor('2026-09-13', []), /No confirmed creator anytime-touchdown records/);
});
