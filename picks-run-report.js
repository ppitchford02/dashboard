'use strict';

/**
 * Plain-language Sports Picks run report.
 * Primary = creator-grouped picks only; technical detail stays secondary.
 */

function creatorLabel(pick, roster = []) {
  const id = String(pick?.sourceId || pick?.creatorId || '').trim();
  const hit = (roster || []).find((row) => row && row.id === id);
  if (hit && hit.name) return String(hit.name);
  if (pick?.creatorName) return String(pick.creatorName);
  return id || 'Unknown creator';
}

function pickLine(pick) {
  const selection = String(pick?.selection || '').trim();
  if (!selection) return '';
  const kind = String(pick?.kind || pick?.classification || pick?.outcome || '').toLowerCase();
  const odds = pick?.odds;
  const oddsText = Number.isInteger(odds) ? ` (${odds > 0 ? '+' : ''}${odds})` : '';
  const lean = kind === 'lean' ? ' [lean]' : '';
  return `- ${selection}${oddsText}${lean}`;
}

function formatRunReport(input = {}) {
  const picks = Array.isArray(input.picks) ? input.picks : [];
  const needsReview = Array.isArray(input.needsReview) ? input.needsReview : [];
  const accountsChecked = Number.isInteger(input.accountsChecked) ? input.accountsChecked : 0;
  const roster = Array.isArray(input.roster) ? input.roster : [];

  const groups = new Map();
  for (const pick of picks) {
    // Reports are actionable recommendations, not a replay of historical captures.
    if (!Number.isFinite(Date.parse(pick.eventStartAt)) || Date.parse(pick.eventStartAt) <= (input.now ?? Date.now()) || !/^https:\/\//.test(pick.eventTimeSource || '') || ['win','loss','push','void'].includes(pick.status)) continue;
    const kind = String(pick?.kind || pick?.classification || pick?.outcome || '').toLowerCase();
    if (pick?.status === 'review' || kind === 'unclear' || kind === 'review') continue;
    const label = creatorLabel(pick, roster);
    if (!groups.has(label)) groups.set(label, []);
    const line = pickLine(pick);
    if (line) groups.get(label).push(line);
  }

  const blocks = [];
  for (const [label, lines] of groups) {
    if (!lines.length) continue;
    blocks.push(`${label}\n${lines.join('\n')}`);
  }

  const savedCount = picks.length;
  const listedCount = [...groups.values()].reduce((n, lines) => n + lines.length, 0);
  const reviewRecords = picks.filter(p => p.status === 'review' || ['unclear','review'].includes(p.kind)).length;
  const reviewCount = needsReview.length;
  const unfinishedPosts = Number.isInteger(input.unfinishedPosts) ? input.unfinishedPosts : 0;
  const summary = `${accountsChecked} accounts checked · ${savedCount} picks saved · ${reviewCount} need review${unfinishedPosts ? ` · ${unfinishedPosts} unfinished posts` : ''}${reviewRecords ? ` · ${reviewRecords} saved records awaiting verification` : ''}`;
  let primary = blocks.length ? `${blocks.join('\n\n')}\n\n${summary}` : summary;

  if (reviewCount > 0) {
    const rows = needsReview.map((item) => {
      const who = String(item.creator || item.sourceId || 'Unknown').trim();
      const what = String(item.pick || item.selection || '').trim();
      const missing = String(item.missing || item.missingFact || '').trim();
      return `- ${who}: ${what}${missing ? ` — missing ${missing}` : ''}`;
    });
    primary += `\n\nNeeds review\n${rows.join('\n')}`;
  }

  const technical = String(input.technical || '').trim();
  const note = technical ? `${primary}\n\nTechnical details\n${technical}` : primary;
  return { primary, technical, note, counts: { accountsChecked, picksSaved: savedCount, picksListed: listedCount, needsReview: reviewCount, unfinishedPosts, reviewRecords } };
}

// Worker receipt notes have a 2,000-character limit. Never let a verbose
// report prevent the aggregate receipt from being persisted.
function boundedReceiptNote(report, limit = 2000) {
  if (report.note.length <= limit) return report.note;
  const primary = report.primary.length <= limit ? report.primary :
    `${report.counts.accountsChecked} accounts checked · ${report.counts.picksSaved} picks saved · ${report.counts.needsReview} need review · ${report.counts.reviewRecords} saved records awaiting verification · ${report.counts.unfinishedPosts} unfinished posts. Full selections are available in the private dashboard.`;
  const separator = '\n\nTechnical details\n';
  const room = limit - primary.length - separator.length;
  return room > 20 && report.technical ? primary + separator + report.technical.slice(0, room - 1) + '…' : primary;
}
module.exports = { formatRunReport, creatorLabel, pickLine, boundedReceiptNote };
