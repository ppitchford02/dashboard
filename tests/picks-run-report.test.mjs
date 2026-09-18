import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { formatRunReport } = require('../picks-run-report.js');

// Fictional example selections only — not live desk records.

test('primary report is creator-grouped plain picks with a short count line', () => {
  const report = formatRunReport({
    accountsChecked: 11,
    roster: [{ id: 'stunad', name: 'Stunad' }, { id: 'nick', name: "Nick's Picks" }],
    picks: [
      { sourceId: 'stunad', selection: 'Riley Greene — home run', kind: 'firm' },
      { sourceId: 'stunad', selection: 'Jo Adell — home run', kind: 'firm' },
      {
        sourceId: 'nick',
        selection: '4-leg parlay (+260): Khalil Shakir 30+ receiving yards; Josh Allen anytime touchdown; Dalton Knox 3+ receptions; fourth leg',
        kind: 'firm',
      },
      { sourceId: 'nick', selection: 'Bijan Robinson over 125 rush+rec yards', kind: 'lean', odds: 100 },
    ],
    needsReview: [],
    technical: 'fresh=98 skipped=0 hashes=...',
  });
  assert.match(report.primary, /^Stunad\n- Riley Greene — home run\n- Jo Adell — home run/);
  assert.match(report.primary, /Nick's Picks\n- 4-leg parlay/);
  assert.match(report.primary, /\[lean\]/);
  assert.match(report.primary, /11 accounts checked · 4 picks saved · 0 need review/);
  assert.equal(report.primary.includes('fresh=98'), false);
  assert.equal(report.primary.includes('cheat sheet'), false);
  assert.match(report.note, /Technical details\nfresh=98/);
  assert.equal(report.note.startsWith(report.primary), true);
});

test('Needs review appears only when Z > 0 and names the missing fact', () => {
  const withReview = formatRunReport({
    accountsChecked: 2,
    picks: [{ sourceId: 'bat', creatorName: 'MLB Bat Guy', selection: 'PCA home run', kind: 'firm' }],
    needsReview: [{ creator: 'MLB Bat Guy', pick: 'PCA home run', missing: 'player name confirmed beyond ASR' }],
  });
  assert.match(withReview.primary, /Needs review\n- MLB Bat Guy: PCA home run — missing player name confirmed beyond ASR/);

  const clean = formatRunReport({
    accountsChecked: 2,
    picks: [{ sourceId: 'bat', creatorName: 'MLB Bat Guy', selection: 'PCA home run', kind: 'firm' }],
    needsReview: [],
  });
  assert.equal(clean.primary.includes('Needs review'), false);
});

test('formatter runs with the committed synthetic roster and preserves all parlay legs', () => {
  const roster = JSON.parse(fs.readFileSync(new URL('./fixtures/roster.json', import.meta.url), 'utf8'));
  const selection = '4-leg parlay: Player A 30+ yards; Player B touchdown; Player C 3+ catches; Player D 40+ yards';
  const report = formatRunReport({roster, picks:[{sourceId:roster[0].id, selection, odds:null, kind:'firm'}]});
  assert.ok(report.primary.includes(roster[0].name));
  assert.ok(report.primary.includes(selection));
});

test('long reports remain within the Worker receipt limit without dropping the receipt', () => {
  const { boundedReceiptNote } = require('../picks-run-report.js');
  const report = formatRunReport({accountsChecked:11, picks:Array.from({length:40},(_,i)=>({sourceId:'example',selection:`Player ${i} `+'long selection '.repeat(10),kind:'firm'})),technical:'debug '.repeat(1000)});
  const note=boundedReceiptNote(report);
  assert.ok(note.length<=2000);
  assert.match(note,/Full selections are available/);
  const short=formatRunReport({picks:[{sourceId:'example',selection:'Player A home run'}],technical:'debug '.repeat(1000)});
  assert.ok(boundedReceiptNote(short).includes('Player A home run'));
  assert.ok(boundedReceiptNote(short).length<=2000);
});
