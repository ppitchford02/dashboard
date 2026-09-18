import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ladder = require('../picks-evidence-ladder.js');

test('evidence ladder tries caption, then transcript, then OCR before review', () => {
  assert.deepEqual(ladder.EVIDENCE_STEPS, [
    'caption_or_post_text',
    'local_transcript',
    'ocr_visible_graphic',
  ]);
  assert.equal(ladder.nextEvidenceStep([]), 'caption_or_post_text');
  assert.equal(ladder.nextEvidenceStep(['caption_or_post_text']), 'local_transcript');
  assert.equal(ladder.nextEvidenceStep(['caption_or_post_text', 'local_transcript']), 'ocr_visible_graphic');
  assert.equal(ladder.nextEvidenceStep(ladder.EVIDENCE_STEPS), null);
  assert.equal(ladder.evidenceLadderComplete(ladder.EVIDENCE_STEPS), true);
  assert.match(ladder.evidenceLadderInstruction(), /Comments are never pick evidence/i);
});
