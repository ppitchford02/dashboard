import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../picks.js', import.meta.url), 'utf8');
// The roster is a deployment secret. These tests run against a fully synthetic fixture,
// so they never read it and never depend on a local secret file.
const PICK_ROSTER = JSON.parse(readFileSync(new URL('./fixtures/roster.json', import.meta.url), 'utf8'));
const ROSTER_LIST = PICK_ROSTER;
const account = (creator, index) => ROSTER_LIST.find(entry => entry.id === creator).accounts[index].id;
const template = readFileSync(new URL('../template.html', import.meta.url), 'utf8');

// Only the DOM operations used by the Picks UI are needed. IDs and form fields
// come from the real template so missing production elements fail the tests.
class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.readOnly = false;
    this.open = false;
    this.dataset = {};
    this._text = '';
    Object.assign(this, attributes);
    this.hidden = 'hidden' in attributes;
    if ('data-close' in attributes) this.dataset.close = attributes['data-close'];
    const classes = new Set();
    this.classList = {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains: name => classes.has(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  setAttribute(name, value) { this[name] = String(value); }
  async fire(type) {
    const event = { target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const listener of this.listeners.get(type) || []) await listener.call(this, event);
    return event;
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function attributes(text) {
  const result = {};
  for (const match of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) result[match[1]] = match[2] ?? '';
  return result;
}

function harness(api) {
  const ids = new Map(), nodes = [], tools = new Map();
  for (const match of template.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = attributes(match[2]);
    if (!attrs.id && !('data-close' in attrs)) continue;
    const element = new Element(match[1], attrs);
    nodes.push(element);
    if (attrs.id) ids.set(attrs.id, element);
  }
  const formMarkup = template.match(/<form id="pick-form">([\s\S]*?)<\/form>/)[1];
  const fields = new Map();
  for (const match of formMarkup.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = attributes(match[2]);
    if (!attrs.name) continue;
    const element = ids.get(attrs.id) || new Element(match[1], attrs);
    fields.set(attrs.name, element);
  }
  const get = id => {
    assert.ok(ids.has(id), `Template is missing #${id}`);
    return ids.get(id);
  };
  get('pick-form').elements = { namedItem: name => fields.get(name) };
  get('pick-form').reset = () => {
    for (const field of fields.values()) { field.value = ''; field.checked = false; }
  };
  get('picks-sport').value = 'all';
  get('picks-view').value = 'all';
  const document = {
    getElementById: get,
    createElement(tag) { const element = new Element(tag); nodes.push(element); return element; },
    querySelectorAll(selector) {
      if (selector === '[data-close]') return nodes.filter(n => n.dataset.close);
      if (selector === '#view-picks button,#pick-dialog button,#pick-detail button') return nodes.filter(n => n.tagName === 'BUTTON');
      throw new Error(`Unexpected selector: ${selector}`);
    },
    modelContext: { registerTool(tool) { tools.set(tool.name, tool); } },
  };
  const opened = [];
  const context = vm.createContext({ document, navigator: {}, window: { open: (url) => { opened.push(url); return null; } } });
  vm.runInContext(script, context, { filename: 'picks.js' });
  context.window.PitchfordPicks.init(api);
  const tool = name => {
    assert.ok(tools.has(name), `Tool ${name} was not registered`);
    return tools.get(name);
  };
  return { get, fields, tool, context, opened };
}

function pick(overrides = {}) {
  return {
    id: 'example-pick', sourceId: 'sbd', sport: 'MLB', market: 'Home run',
    selection: 'Example player home run', event: 'Example away at Example home',
    eventStartAt:'2099-09-11T23:00:00Z', eventTimeSource:'https://example.com/schedule', eventDate: '2026-09-11', odds: 350, postedAt: '2026-09-11T12:00:00Z',
    sourceUrl: 'https://example.com/source-post', originalText: 'Example source evidence.',
    capturedBeforeStart: true, status: 'pending', resultEvidence: '', resultUrl: '',
    createdAt: '2026-09-11T12:05:00Z', updatedAt: '2026-09-11T12:05:00Z',
    archived: false, revision: 1, ...overrides,
  };
}

test('current picks expire at start and never display settled or untimed records', () => {
  const ui=harness(async()=>desk());
  const current=ui.context.window.PitchfordPicks.currentPick;
  const p=pick({eventStartAt:'2026-09-21T23:00:00Z'});
  assert.equal(current(p,Date.parse('2026-09-21T22:59:59Z')),true);
  assert.equal(current(p,Date.parse('2026-09-21T23:00:00Z')),false);
  assert.equal(current({...p,eventStartAt:''},0),false);
  assert.equal(current({...p,status:'win'},0),false);
});

const desk = (picks = []) => ({ roster: PICK_ROSTER, picks, checks: [], revisions: [] });

test('source checks can be saved from the dashboard and failed notes remain editable', async () => {
  const sent = [];
  const checks = [];
  let fail = true;
  const ui = harness(async body => {
    if (body.action === 'read') return { ...desk(), checks: checks.map(check => ({ ...check })) };
    sent.push(JSON.parse(JSON.stringify(body)));
    if (fail) throw new Error('Connection lost');
    const check = { id: 'check-1', ...body, checkedAt: '2026-09-12T22:20:00Z' };
    checks.unshift(check);
    return { check };
  });
  await ui.get('picks-unlock').fire('click');
  assert.equal(ui.get('picks-check-source').children.length, 6);
  ui.get('picks-check-source').value = 'bat';
  ui.get('picks-check-status').value = 'Needs review';
  ui.get('picks-check-note').value = 'Caption cannot be verified from the visible post.';
  await ui.get('picks-check-form').fire('submit');
  assert.match(ui.get('picks-check-error').textContent, /Connection lost/);
  assert.equal(ui.get('picks-check-note').value, 'Caption cannot be verified from the visible post.');
  fail = false;
  await ui.get('picks-check-form').fire('submit');
  assert.equal(ui.get('picks-check-error').textContent, '');
  assert.equal(ui.get('picks-check-note').value, '');
  assert.deepEqual(sent.at(-1), { action: 'check', sourceId: 'bat', status: 'Needs review', note: 'Caption cannot be verified from the visible post.' });
  assert.match(ui.get('picks-sources').textContent, /Caption cannot be verified/);
});

test('renders exactly six source tabs and collapses matching picks into one credited card', async () => {
  const randy = pick({ id: 'sbd-randy', sourceId: 'sbd', selection: 'Randy Arozarena — 1+ home run' });
  const sameRandy = pick({ id: 'bat-randy', sourceId: 'bat', selection: 'Randy Arozarena — home run', odds: 400 });
  const ui = harness(async body => {
    assert.equal(body.action, 'read');
    return desk([randy, sameRandy]);
  });
  await ui.get('picks-unlock').fire('click');
  const tabs = ui.get('picks-source-tabs').children;
  assert.equal(tabs.length, 6);
  assert.deepEqual(tabs.map(tab => tab.dataset.source), ['danny', 'stunad', 'nick', 'cru', 'sbd', 'bat']);
  assert.equal(tabs[4].textContent, `${ROSTER_LIST[4].name} (1)`);
  assert.equal(tabs[5].textContent, `${ROSTER_LIST[5].name} (0)`);
  assert.equal(ui.get('picks-list').children.length, 1);
  assert.match(ui.get('picks-list').textContent, /Randy Arozarena/);
  assert.equal(ui.get('picks-list').textContent.includes(`${ROSTER_LIST[4].name} evidence`), true);
  assert.equal(ui.get('picks-list').textContent.includes(`${ROSTER_LIST[5].name} evidence`), true);
});

test('capture rejects malformed odds before any API request and preserves the form', async () => {
  let calls = 0;
  const ui = harness(async body => { if (body.action === 'read') return desk(); calls++; throw new Error('Invalid odds must never reach the API'); });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-add').fire('click');
  ui.fields.get('originalText').value = 'Keep this original evidence.';
  for (const value of ['abc', '1e309', '150.5', '99', '-99', '100001']) {
    ui.fields.get('odds').value = value;
    const event = await ui.get('pick-form').fire('submit');
    assert.equal(event.defaultPrevented, true);
    assert.equal(calls, 0, `${value} should be rejected before serialization`);
    assert.match(ui.get('pick-form-error').textContent, /American odds/);
    assert.equal(ui.get('pick-dialog').open, true);
    assert.equal(ui.fields.get('originalText').value, 'Keep this original evidence.');
  }
});

test('capture sends exact valid odds or intentional null for an empty field', async () => {
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return desk();
    assert.equal(body.action, 'save');
    sent.push(JSON.parse(JSON.stringify(body.pick)));
    return { pick: pick({ ...body.pick }) };
  });
  await ui.get('picks-unlock').fire('click');
  for (const [value, expected] of [['+350', 350], [' -110 ', -110], ['', null]]) {
    await ui.get('picks-add').fire('click');
    ui.get('pick-account').value = account('danny', 0);
    ui.fields.get('originalText').value = 'Give me the example side tonight.';
    ui.fields.get('sourceUrl').value = 'https://example.com/post/1';
    await ui.get('pick-recheck').fire('click');
    ui.fields.get('odds').value = value;
    await ui.get('pick-form').fire('submit');
    assert.equal(sent.at(-1).odds, expected);
    assert.equal(ui.get('pick-form-error').textContent, '');
    assert.equal(ui.get('pick-dialog').open, false);
  }
  assert.equal(sent.length, 3);
});

test('committed settlement and capture remain successful when list refresh fails', async () => {
  const original = pick(), settled = pick({ status: 'win', resultEvidence: 'Verified result.', revision: 2 });
  const captured = pick({ id: 'another-pick', selection: 'Another example player home run' });
  const actions = [];
  const ui = harness(async body => {
    actions.push(body.action);
    if (body.action === 'read') {
      if (actions.length === 1) return desk([original]);
      throw new Error('Refresh connection lost');
    }
    if (body.action === 'settle') {
      assert.equal(body.id, original.id);
      assert.equal(body.revision, 1);
      assert.equal(body.status, 'win');
      return { pick: settled };
    }
    assert.equal(body.action, 'save');
    return { pick: captured };
  });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-list').children[0].fire('click');
  ui.get('pick-outcome').value = 'win';
  ui.get('pick-result-note').value = 'Verified result.';
  await ui.get('pick-result-form').fire('submit');
  assert.equal(ui.get('pick-result-error').textContent, '');
  assert.equal(ui.get('pick-detail').open, false);
  assert.equal(ui.get('picks-message').textContent, 'Result saved.');
  assert.equal(ui.get('picks-sync-warning').hidden, false);
  assert.match(ui.get('picks-sync-warning').textContent, /Saved successfully.*could not refresh/);
  await ui.get('picks-list').children[0].fire('click');
  assert.match(ui.get('pick-history').textContent, /Version 2/);
  assert.equal(ui.get('pick-outcome').value, 'win');

  const result = JSON.parse(await ui.tool('dashboard_picks_capture').execute(captured));
  assert.equal(result.pick.id, captured.id);
  assert.match(result.refreshWarning, /Saved successfully/);
  assert.equal(ui.get('picks-list').children.length, 2);
  assert.match(ui.get('picks-list').textContent, /Another example player home run/);
  assert.deepEqual(actions, ['read', 'settle', 'read', 'save', 'read']);
});

test('WebMCP read rejects failed or canceled fresh reads instead of returning cached picks', async () => {
  let calls = 0;
  const ui = harness(async body => {
    assert.equal(body.action, 'read');
    calls++;
    if (calls === 1) return desk([pick()]);
    if (calls === 2) throw new Error('Network unavailable');
    return null;
  });
  const read = ui.tool('dashboard_picks_read');
  assert.equal(read.annotations.readOnlyHint, true);
  const initial = JSON.parse(await read.execute({}));
  assert.equal(initial.picks[0].id, 'example-pick');
  await assert.rejects(read.execute({}), /Could not read fresh picks/);
  assert.match(ui.get('picks-message').textContent, /Network unavailable/);
  await assert.rejects(read.execute({}), /Could not read fresh picks/);
  assert.equal(calls, 3);
});

const lines = ui => ui.get('picks-clean-list').children.map(node => node.textContent);

test('a creator’s accounts are selectable and captured under the one creator id', async () => {
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return desk();
    sent.push(JSON.parse(JSON.stringify(body.pick)));
    return { pick: pick({ ...body.pick }) };
  });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-add').fire('click');
  assert.deepEqual(ui.get('pick-account').children.map(option => option.value), ['', account('danny', 0), account('danny', 1), account('danny', 2)]);
  assert.deepEqual(ui.get('pick-account').children.map(option => option.textContent), ['Select the account', ...ROSTER_LIST[0].accounts.map(entry => entry.platform)]);
  ui.get('pick-account').value = account('danny', 2);
  ui.fields.get('originalText').value = 'Give me Texans moneyline tonight.';
  ui.fields.get('selection').value = 'Texans';
  ui.fields.get('sourceUrl').value = 'https://example.com/post/2';
  await ui.get('pick-recheck').fire('click');
  await ui.get('pick-form').fire('submit');
  assert.equal(ui.get('pick-form-error').textContent, '');
  assert.equal(sent.at(-1).sourceId, 'danny');
  assert.equal(sent.at(-1).accountId, account('danny', 2));
});

test('the clean list shows one plain line per confirmed pick, deduplicated across a creator’s accounts', async () => {
  const instagram = pick({
    id: 'danny-ig', sourceId: 'danny', accountId: account('danny', 0), sport: 'NFL', market: 'Moneyline',
    selection: 'Texans', event: 'Texans at Colts', originalText: 'Texans moneyline tonight.',
  });
  const tiktok = pick({ ...instagram, id: 'danny-tt', accountId: account('danny', 1), odds: 120 });
  const total = pick({
    id: 'cru-total', sourceId: 'cru', accountId: account('cru', 1), sport: 'NFL', market: 'Total',
    selection: 'over 42.5', event: 'Bengals–Buccaneers', originalText: 'Bengals–Buccaneers over 42.5 for me.',
  });
  const ui = harness(async () => desk([instagram, tiktok, total]));
  await ui.get('picks-unlock').fire('click');
  assert.deepEqual(lines(ui), ['- Texans moneyline', '- Bengals–Buccaneers over 42.5']);
  assert.equal(ui.get('picks-clean-held').textContent, '');
  // The clean list carries no captions, post times, platforms, or check notes.
  const shown = ui.get('picks-clean-list').textContent;
  for (const leak of ['Instagram', 'TikTok', account('danny', 0), 'tonight', '2026-09-11', 'https://'])
    assert.equal(shown.includes(leak), false, `clean list leaked ${leak}`);
});

test('unclear, hedged and unreviewed picks are held back with the reason kept out of the clean list', async () => {
  const good = pick({
    id: 'keep', sourceId: 'nick', accountId: account('nick', 1), sport: 'NFL', market: 'Spread',
    selection: 'Cowboys -3.5', event: 'Cowboys at Giants', originalText: 'Cowboys -3.5 is the play.',
  });
  const held = [
    pick({ id: 'hedge', sourceId: 'nick', sport: 'NFL', market: 'Moneyline', selection: 'Leaning Bears', event: 'Bears at Packers', originalText: 'Leaning Bears here.' }),
    pick({ id: 'question', sourceId: 'cru', sport: 'NFL', market: 'Moneyline', selection: 'Jets?', event: 'Jets at Bills', originalText: 'Jets? not sure' }),
    pick({ id: 'unsupported', sourceId: 'cru', sport: 'NFL', market: 'Spread', selection: 'Broncos -7.5 first half', event: 'Broncos at Raiders', originalText: 'Something else entirely about a different game.' }),
    pick({ id: 'late', sourceId: 'stunad', sport: 'NFL', market: 'Moneyline', selection: 'Rams', event: 'Rams at Seahawks', originalText: 'Rams moneyline.', capturedBeforeStart: false }),
    pick({ id: 'needs-review', sourceId: 'bat', status: 'review', selection: 'Example player home run', originalText: 'Example player home run.' }),
    pick({ id: 'no-link', sourceId: 'bat', sourceUrl: '', selection: 'Another example player home run', originalText: 'Another example player home run.' }),
  ];
  const ui = harness(async () => desk([good, ...held]));
  await ui.get('picks-unlock').fire('click');
  assert.deepEqual(lines(ui), ['- Cowboys -3.5']);
  assert.equal(ui.get('picks-clean-held').textContent, '6 picks are held back. The reason for each stays in the private record.');
  const shown = ui.get('picks-clean-list').textContent + ui.get('picks-clean-held').textContent;
  for (const leak of ['Leaning', 'Jets', 'Broncos', 'Rams', 'evidence', 'question'])
    assert.equal(shown.includes(leak), false, `held-back detail leaked ${leak}`);
  const stored = JSON.parse(await ui.tool('dashboard_picks_read').execute({}));
  assert.deepEqual(stored.cleanList, ['Cowboys -3.5']);
  assert.deepEqual(stored.heldBack.map(item => item.id).sort(), ['hedge', 'late', 'needs-review', 'no-link', 'question', 'unsupported']);
  assert.match(stored.heldBack.find(item => item.id === 'unsupported').reason, /not supported by the stored original evidence/);
  assert.match(stored.heldBack.find(item => item.id === 'late').reason, /before the event started/);
});

test('the page holds no roster until it is unlocked, then mirrors the private one', async () => {
  const ui = harness(async () => desk());
  assert.equal(ui.context.window.PitchfordPicks.sources().length, 0, 'a locked page knows no creator');
  assert.equal(ui.get('pick-source').children.length, 0);
  assert.equal(ui.get('picks-check-source').children.length, 0);
  await ui.get('picks-unlock').fire('click');
  const sources = JSON.parse(JSON.stringify(ui.context.window.PitchfordPicks.sources()));
  assert.deepEqual(sources.map(creator => creator.id), PICK_ROSTER.map(creator => creator.id));
  assert.deepEqual(sources.flatMap(creator => creator.accounts.map(account => account.url)), PICK_ROSTER.flatMap(creator => creator.accounts.map(account => account.url)));
  const ids = sources.flatMap(creator => creator.accounts.map(account => account.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const account of sources.flatMap(creator => creator.accounts)) assert.match(account.url, /^https:\/\//);
  assert.equal(ui.get('picks-check-source').children.length, PICK_ROSTER.length);
});

test('the capture form requires an account when the creator has more than one', async () => {
  let calls = 0;
  const ui = harness(async body => { if (body.action === 'read') return desk(); calls++; return { pick: pick({ ...body.pick }) }; });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-add').fire('click');
  assert.equal(ui.get('pick-account').value, '');
  assert.equal(ui.get('pick-account').children[0].textContent, 'Select the account');
  ui.fields.get('originalText').value = 'Give me Texans moneyline tonight.';
  ui.fields.get('selection').value = 'Texans';
  ui.fields.get('sourceUrl').value = 'https://example.com/post/3';
  await ui.get('pick-recheck').fire('click');
  const event = await ui.get('pick-form').fire('submit');
  assert.equal(event.defaultPrevented, true);
  assert.equal(calls, 0, 'a pick with no account must never reach the API');
  assert.match(ui.get('pick-form-error').textContent, /accounts this pick came from/);
  assert.equal(ui.get('pick-dialog').open, true);
  // A creator with one account is filled in automatically rather than left blank.
  ui.fields.get('sourceId').value = 'stunad';
  await ui.fields.get('sourceId').fire('change');
  assert.equal(ui.get('pick-account').value, account('stunad', 0));
  assert.deepEqual(ui.get('pick-account').children.map(option => option.textContent), ROSTER_LIST[1].accounts.map(entry => entry.platform));
  await ui.get('pick-form').fire('submit');
  assert.equal(ui.get('pick-form-error').textContent, '');
  assert.equal(calls, 1);
});

test('a historical pick with no recorded account stays editable and unchanged', async () => {
  const legacy = pick({ id: 'legacy', sourceId: 'danny', sport: 'NFL', market: 'Moneyline', selection: 'Texans', event: 'Texans at Colts', originalText: 'Texans moneyline tonight.' });
  delete legacy.accountId;
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return desk([legacy]);
    sent.push(JSON.parse(JSON.stringify(body)));
    return { pick: { ...legacy, revision: 2 } };
  });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-list').children[0].fire('click');
  await ui.get('pick-edit').fire('click');
  assert.equal(ui.get('pick-account').children[0].textContent, 'Account not recorded');
  assert.equal(ui.get('pick-account').value, '');
  assert.equal(ui.get('pick-account').disabled, true);
  ui.fields.get('reason').value = 'Correcting the event name only.';
  await ui.get('pick-form').fire('submit');
  assert.equal(ui.get('pick-form-error').textContent, '');
  assert.equal(sent.at(-1).action, 'edit');
  assert.equal(sent.at(-1).pick.accountId, '');
});

// Fixture transcripts. Invented wording for tests only; no reel was opened.
const REEL = [
  'Alright, welcome back to the show.',
  'Give me Texans moneyline tonight.',
  'I would have to lean Bengals–Buccaneers over 42.5 on this one.',
  'Somebody in the comments said take the Jets, I am not touching that.',
  'The play is Cowboys -3.5.',
  'I mean, the weather could be a factor.',
  'Maybe the Rams later, we will see.',
].join(' ');

test('reel extraction separates firm picks from leans and ignores relayed or empty lines', async () => {
  const ui = harness(async () => desk());
  const { candidates, ignored } = ui.context.window.PitchfordPicks.extractFromTranscript(REEL);
  assert.deepEqual(JSON.parse(JSON.stringify(candidates.map(c => [c.kind, c.selection]))), [
    ['firm', 'Texans moneyline tonight'],
    ['lean', 'Bengals–Buccaneers over 42.5 on this one'],
    ['firm', 'Cowboys -3.5'],
    ['lean', 'the Rams later, we will see'],
  ]);
  const skipped = JSON.parse(JSON.stringify(ignored));
  assert.equal(skipped.some(item => /comments/.test(item.sentence) && /Relays/.test(item.reason)), true);
  assert.equal(candidates.some(c => /Jets/.test(c.selection)), false, 'a viewer comment must never become a pick');
  assert.equal(skipped.some(item => /weather/.test(item.sentence)), true);
  assert.equal(ui.context.window.PitchfordPicks.extractFromTranscript('').candidates.length, 0);
});

test('no transcription runtime is installed, so the local adapter reports the missing dependency', async () => {
  const ui = harness(async () => desk());
  const listed = JSON.parse(await ui.tool('dashboard_reel_transcribers').execute({}));
  assert.deepEqual(listed, [
    { id: 'provided', label: 'Transcript supplied by the caller', available: true },
    { id: 'local-whisper', label: 'Local Whisper runtime', available: false },
  ]);
  await assert.rejects(
    ui.tool('dashboard_reel_intake').execute({ transcriber: 'local-whisper', sourceId: 'danny', accountId: account('danny', 1), sourceUrl: 'https://example.com/private-reel/1' }),
    /No local transcription runtime is installed/,
  );
});

test('reel intake stores the transcript privately and returns spoken selections without saving a pick', async () => {
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return { ...desk(), transcripts: [] };
    sent.push(JSON.parse(JSON.stringify(body)));
    return { transcript: { id: 'reel-1', ...body.transcript } };
  });
  const result = JSON.parse(await ui.tool('dashboard_reel_intake').execute({
    transcriber: 'provided', sourceId: 'danny', accountId: account('danny', 1),
    sourceUrl: 'https://example.com/private-reel/1',
    transcript: REEL, engine: 'supplied-by-browser-run', transcribedAt: '2026-09-14T15:00:00Z',
  }));
  assert.equal(result.transcriptId, 'reel-1');
  assert.equal(result.candidates.length, 4);
  assert.equal(sent.filter(body => body.action === 'save').length, 0, 'intake must not create picks on its own');
  const stored = sent.find(body => body.action === 'transcript').transcript;
  assert.equal(stored.medium, 'audio');
  assert.equal(stored.accountId, account('danny', 1));
  assert.equal(stored.engine, 'supplied-by-browser-run');
  assert.equal(stored.transcript, REEL);
  assert.equal(stored.transcribedAt, '2026-09-14T15:00:00Z');
});

test('leans are listed separately and never reach eligible picks or source records', async () => {
  const firm = pick({
    id: 'firm', sourceId: 'danny', accountId: account('danny', 1), sport: 'NFL', market: 'Moneyline',
    selection: 'Texans', event: 'Texans at Colts', originalText: 'Give me Texans moneyline tonight.',
    status: 'win', odds: -110,
  });
  const lean = pick({
    id: 'lean', kind: 'lean', sourceId: 'danny', accountId: account('danny', 1), sport: 'NFL', market: 'Total',
    selection: 'over 42.5', event: 'Bengals–Buccaneers', originalText: 'I would have to lean Bengals–Buccaneers over 42.5.',
    status: 'win', odds: -110,
  });
  const ui = harness(async () => desk([firm, lean]));
  await ui.get('picks-unlock').fire('click');
  assert.deepEqual(lines(ui), ['- No eligible picks right now.']);
  assert.deepEqual(ui.get('picks-leans-list').children.map(node => node.textContent), ['- No leans recorded.']);
  assert.equal(ui.get('picks-clean-held').textContent, '', 'a lean is not a held-back pick');
  const record = ui.context.window.PitchfordPicks.stats([firm, lean]);
  assert.equal(record.wins, 1);
  assert.equal(record.eligible, 1);
  const stored = JSON.parse(await ui.tool('dashboard_picks_read').execute({}));
  assert.deepEqual(stored.cleanList, []);
  assert.deepEqual(stored.leans.map(item => item.text), []);
});

test('the capture form classifies the pasted wording itself and never asks Preston to choose', async () => {
  const ui = harness(async () => desk());
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-add').fire('click');
  assert.equal(ui.get('pick-kind').disabled, true, 'the class is derived, never chosen');
  for (const [wording, label, kind] of [
    ['Give me Texans moneyline tonight.', 'Firm pick', 'firm'],
    ['The play is Cowboys -3.5.', 'Firm pick', 'firm'],
    ['I would have to lean Bengals over 42.5.', 'Lean', 'lean'],
    ['Maybe the Rams later, we will see.', 'Lean', 'lean'],
    ['The weather could be a factor tonight.', 'Unclear', 'firm'],
    ['Someone in the comments said take the Jets.', 'Unclear', 'firm'],
  ]) {
    ui.fields.get('originalText').value = wording;
    await ui.fields.get('originalText').fire('input');
    assert.equal(ui.get('pick-class-state').textContent.startsWith(label), true, `${wording} -> ${ui.get('pick-class-state').textContent}`);
    assert.equal(ui.get('pick-kind').value, kind, wording);
  }
  assert.match(ui.get('pick-class-state').textContent, /Unclear .* Relays someone/);
  for (const [wording, selection] of [
    ['FIRST TOUCHDOWN SCORER LOTTO @everyone DAVANTE ADAMS', 'Davante Adams — first touchdown scorer'],
    ['Kyren Williams 2+ Receptions The Giants allow receiving yards to RBs.', 'Kyren Williams 2+ receptions'],
    ['Something came across my desk that I would like to add to the card: Malachi Fields Over 25.5 Rec Yards (-115)', 'Malachi Fields Over 25.5 receiving yards'],
  ]) assert.equal(ui.context.window.PitchfordPicks.classify(wording,selection).outcome,'firm');
});

test('a new capture cannot be saved until its own link is reopened once', async () => {
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return desk();
    sent.push(JSON.parse(JSON.stringify(body)));
    return { pick: pick({ ...body.pick }) };
  });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-add').fire('click');
  ui.get('pick-account').value = account('danny', 0);
  ui.fields.get('originalText').value = 'I would have to lean Bengals over 42.5.';
  ui.fields.get('selection').value = 'Bengals over 42.5';
  ui.fields.get('sourceUrl').value = 'https://example.com/post/9';

  const blocked = await ui.get('pick-form').fire('submit');
  assert.equal(blocked.defaultPrevented, true);
  assert.equal(sent.length, 0, 'nothing reaches the API before the link is reopened');
  assert.match(ui.get('pick-form-error').textContent, /Reopen this pick’s source link once before saving/);

  await ui.get('pick-recheck').fire('click');
  assert.deepEqual(ui.opened, ['https://example.com/post/9'], 'the exact link is what gets reopened');
  assert.match(ui.get('pick-recheck-state').textContent, /^Reopened /);

  // Changing the link after the check invalidates it; the old proof cannot carry over.
  ui.fields.get('sourceUrl').value = 'https://example.com/post/10';
  await ui.fields.get('sourceUrl').fire('input');
  assert.match(ui.get('pick-recheck-state').textContent, /Not reopened yet/);
  assert.equal((await ui.get('pick-form').fire('submit')).defaultPrevented, true);
  assert.equal(sent.length, 0);

  await ui.get('pick-recheck').fire('click');
  await ui.get('pick-form').fire('submit');
  assert.equal(ui.get('pick-form-error').textContent, '');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'save');
  assert.equal(sent[0].verification.outcome, 'lean', 'the wording decided it, not the operator');
  assert.equal(sent[0].verification.checkedUrl, 'https://example.com/post/10');
  assert.match(sent[0].verification.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal('kind' in sent[0].pick, true);
  assert.match(ui.get('picks-message').textContent, /saved as lean/);
});

test('a correction to an existing record is not subject to the intake rule', async () => {
  const existing = pick({ id: 'old', sourceId: 'danny', sport: 'NFL', market: 'Moneyline', selection: 'Texans', event: 'Texans at Colts', originalText: 'Texans moneyline tonight.' });
  const sent = [];
  const ui = harness(async body => {
    if (body.action === 'read') return desk([existing]);
    sent.push(JSON.parse(JSON.stringify(body)));
    return { pick: { ...existing, revision: 2 } };
  });
  await ui.get('picks-unlock').fire('click');
  await ui.get('picks-list').children[0].fire('click');
  await ui.get('pick-edit').fire('click');
  assert.equal(ui.get('pick-recheck-row').hidden, true, 'no recheck is asked for on a correction');
  assert.equal(ui.get('pick-class-state').textContent, 'Firm pick');
  ui.fields.get('reason').value = 'Corrected the event name only.';
  await ui.get('pick-form').fire('submit');
  assert.equal(ui.get('pick-form-error').textContent, '');
  assert.equal(sent.at(-1).action, 'edit');
  assert.equal('verification' in sent.at(-1), false);
  assert.deepEqual(ui.opened, [], 'nothing was reopened for a historical record');
});

test('the capture tool demands the reopened link and time up front', async () => {
  const ui = harness(async () => desk());
  const schema = ui.tool('dashboard_picks_capture').inputSchema;
  assert.equal(schema.properties.checkedUrl.type, 'string');
  assert.equal(schema.properties.checkedAt.type, 'string');
  assert.equal(schema.required.includes('checkedUrl'), true);
  assert.equal(schema.required.includes('checkedAt'), true);
  assert.equal('kind' in schema.properties, false, 'an agent cannot assert a class');
  assert.match(ui.tool('dashboard_picks_capture').description, /Reopen the pick’s exact source link once immediately before calling this/);
  assert.match(ui.tool('dashboard_picks_capture').description, /derived from the captured wording, never chosen/);
});

test('the automation tool loads the desk with a token and never asks for the passphrase', async () => {
  const seen = [];
  const ui = harness(async body => {
    seen.push(JSON.parse(JSON.stringify(body)));
    if (body.action === 'read') return desk([pick({ id: 'existing' })]);
    return { pick: pick({ ...body.pick }) };
  });
  const result = JSON.parse(await ui.tool('dashboard_picks_automation_token').execute({ token: 'test-automation-token-0123456789abcdef' }));
  assert.equal(result.authenticated, 'automation token');
  assert.equal(result.creators, PICK_ROSTER.length);
  assert.equal(result.picks, 1);
  assert.equal(seen[0].agentToken, 'test-automation-token-0123456789abcdef', 'the token rides on the request');
  assert.equal('pass' in seen[0], false, 'the page never supplies a passphrase for automation');
  assert.equal(ui.tool('dashboard_picks_automation_token').annotations.readOnlyHint, false, 'the automation tool writes, so it is not read-only');
  assert.match(ui.tool('dashboard_picks_automation_token').description, /never printed|Never print/);

  // Every later call carries the token too, including a capture.
  await ui.get('picks-add').fire('click');
  ui.get('pick-account').value = account('danny', 0);
  ui.fields.get('originalText').value = 'Give me the example side tonight.';
  ui.fields.get('selection').value = 'Example side';
  ui.fields.get('sourceUrl').value = 'https://example.com/post/agent';
  await ui.get('pick-recheck').fire('click');
  await ui.get('pick-form').fire('submit');
  const save = seen.find(body => body.action === 'save');
  assert.equal(save.agentToken, 'test-automation-token-0123456789abcdef');
  assert.equal(save.verification.checkedUrl, 'https://example.com/post/agent');
});

test('a rejected automation token leaves the desk locked and keeps nothing', async () => {
  const ui = harness(async () => null);
  await assert.rejects(
    ui.tool('dashboard_picks_automation_token').execute({ token: 'a-token-the-worker-will-not-accept' }),
    /was not accepted/,
  );
  await assert.rejects(ui.tool('dashboard_picks_automation_token').execute({ token: '   ' }), /No automation token/);
  assert.equal(ui.get('picks-content').hidden, true, 'the desk stays locked');
});

test('run summary renders saved selections even with a legacy technical receipt and keeps diagnostics collapsed', async () => {
  const parlay='4-leg parlay: A 30+ yards; B touchdown; C 3+ catches; D 40+ yards';
  const current=pick({selection:parlay,odds:null,kind:'firm'});
  const lean=pick({id:'lean',sourceId:'nick',selection:'Player E home run',kind:'lean'});
  const old=pick({id:'old',selection:'OLD selection',createdAt:'2026-09-10T12:00:00Z'});
  const ui=harness(async()=>({...desk([current,lean,old]),latestRun:{outcome:'complete',startedAt:'2026-09-11T12:00:00Z',completedAt:'2026-09-11T12:10:00Z',accountsChecked:11,accountsBlocked:0,picksSaved:2,note:'GATE STILL BROKEN debug hash=secret-example'}}));
  await ui.get('picks-unlock').fire('click');
  const host=ui.get('picks-run-status');
  const primary=host.children.filter(n=>n.tagName!=='DETAILS').map(n=>n.textContent).join(' ');
  assert.ok(primary.includes(parlay));
  assert.ok(primary.includes('[lean]'));
  assert.ok(primary.includes('2 picks saved'));
  assert.equal(primary.includes('OLD selection'),false);
  assert.equal(primary.includes('GATE STILL BROKEN'),false);
  const detail=host.children.find(n=>n.tagName==='DETAILS');
  assert.equal(detail.open,false);
  assert.match(detail.textContent,/GATE STILL BROKEN/);
});
