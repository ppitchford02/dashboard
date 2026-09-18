'use strict';

/**
 * Ordered evidence attempts before Needs review / blank identity-odds fields.
 * Comments are never pick evidence. Unknown fields stay null.
 */
const EVIDENCE_STEPS = Object.freeze([
  'caption_or_post_text',
  'local_transcript',
  'ocr_visible_graphic',
]);

function normalizeDone(done) {
  if (!Array.isArray(done)) return [];
  return done.map((step) => String(step || '').trim()).filter(Boolean);
}

function nextEvidenceStep(done = []) {
  const finished = new Set(normalizeDone(done));
  return EVIDENCE_STEPS.find((step) => !finished.has(step)) || null;
}

function evidenceLadderComplete(done = []) {
  return nextEvidenceStep(done) === null;
}

function evidenceLadderInstruction() {
  return (
    'Before Needs review or leaving identity/odds blank, attempt available evidence in order: '
    + 'exact post text/caption, then local audio/video transcript, then OCR of visible graphics when relevant. '
    + 'Comments are never pick evidence. A configured-creator link proves provenance, not exact wording. '
    + 'Unknown fields stay blank/null; never invent.'
  );
}

module.exports = {
  EVIDENCE_STEPS,
  nextEvidenceStep,
  evidenceLadderComplete,
  evidenceLadderInstruction,
};
