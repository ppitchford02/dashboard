import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../picks.js', import.meta.url), 'utf8');
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
  const context = vm.createContext({ document, navigator: {}, window: {} });
  vm.runInContext(script, context, { filename: 'picks.js' });
  context.window.PitchfordPicks.init(api);
  const tool = name => {
    assert.ok(tools.has(name), `Tool ${name} was not registered`);
    return tools.get(name);
  };
  return { get, fields, tool };
}

function pick(overrides = {}) {
  return {
    id: 'example-pick', sourceId: 'sbd', sport: 'MLB', market: 'Home run',
    selection: 'Example player home run', event: 'Example away at Example home',
    eventDate: '2026-09-11', odds: 350, postedAt: '2026-09-11T12:00:00Z',
    sourceUrl: 'https://example.com/source-post', originalText: 'Example source evidence.',
    capturedBeforeStart: true, status: 'pending', resultEvidence: '', resultUrl: '',
    createdAt: '2026-09-11T12:05:00Z', updatedAt: '2026-09-11T12:05:00Z',
    archived: false, revision: 1, ...overrides,
  };
}

const desk = (picks = []) => ({ picks, checks: [], revisions: [] });

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
  assert.match(tabs[4].textContent, /SportsDime \(1\)/);
  assert.match(tabs[5].textContent, /MLB Bat Guy \(0\)/);
  assert.equal(ui.get('picks-list').children.length, 1);
  assert.match(ui.get('picks-list').textContent, /Randy Arozarena/);
  assert.match(ui.get('picks-list').textContent, /SportsDime evidence/);
  assert.match(ui.get('picks-list').textContent, /MLB Bat Guy evidence/);
});

test('capture rejects malformed odds before any API request and preserves the form', async () => {
  let calls = 0;
  const ui = harness(async () => { calls++; throw new Error('Invalid odds must never reach the API'); });
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
  for (const [value, expected] of [['+350', 350], [' -110 ', -110], ['', null]]) {
    await ui.get('picks-add').fire('click');
    ui.fields.get('originalText').value = 'Example source evidence.';
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
