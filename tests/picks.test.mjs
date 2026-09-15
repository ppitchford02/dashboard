import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

const code = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const schema = await readFile(new URL('../schema-picks.sql', import.meta.url), 'utf8');
// The roster is a deployment secret. The tests never read it: they run against a
// fully synthetic fixture, so nothing here depends on a local secret file and no real
// creator name, account id, or account link exists anywhere in this repository.
const ROSTER = await readFile(new URL('./fixtures/roster.json', import.meta.url), 'utf8');
const {default: worker, validatePickInput, validateSettlementInput, pickIdentityText, loadRoster} =
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const ROSTER_LIST = JSON.parse(ROSTER);
const account = (creator, index) => ROSTER_LIST.find(entry => entry.id === creator).accounts[index].id;
const ORIGIN = 'https://ppitchford02.github.io';
const PASS = 'only-used-in-tests';
const source = {
  sourceId: 'nick', accountId: account('nick', 0), sport: 'MLB', market: 'Home run', selection: 'Test Player',
  event: 'Test Away at Test Home', eventDate: '2026-09-11', odds: 350,
  postedAt: '2026-09-11T09:30', sourceUrl: 'https://example.com/channels/1/2/3',
  originalText: 'Original test post: Test Player to hit a home run.', capturedBeforeStart: false,
};

// Execute real SQLite statements/transactions while implementing the small D1
// binding interface used by the Worker. No network, credentials, or real picks.
function database(existing) {
  const sqlite = existing || new DatabaseSync(':memory:');
  if (!existing) sqlite.exec(schema);
  const db = {
    sqlite, beforeBatch: null, beforeRun: null,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() { return sqlite.prepare(sql).get(...this.args) || null; },
        async all() { return {success: true, results: sqlite.prepare(sql).all(...this.args)}; },
        async run() {
          if (db.beforeRun) await db.beforeRun(sql);
          const result = sqlite.prepare(sql).run(...this.args);
          return {success: true, meta: {changes: Number(result.changes)}};
        },
      };
      return statement;
    },
    async batch(statements) {
      if (db.beforeBatch) await db.beforeBatch();
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return db;
}

async function api(db, body, options = {}) {
  const request = new Request('https://worker.example/picks', {
    method: options.method || 'POST',
    headers: {'content-type': 'application/json', origin: ORIGIN, ...options.headers},
    ...(options.method && options.method !== 'POST' ? {} : {body: JSON.stringify(options.agent ? body : {pass: PASS, ...body})}),
  });
  const response = await worker.fetch(request, {DASH_PASSPHRASE: PASS, PICKS_ROSTER: ROSTER, PICKS_DB: db, ...options.env});
  const data = response.status === 204 ? null : await response.json();
  return {status: response.status, data, headers: response.headers};
}

// Every new capture must carry proof that its own source link was reopened first.
// Historical records and imports are not subject to the rule, so those paths pass none.
const capture = (pick, outcome = 'firm', reason = '') => ({
  action: 'save', pick,
  verification: {outcome, reason, checkedUrl: pick.sourceUrl, checkedAt: '2026-09-13T12:30:00Z'},
});

async function save(db, changes = {}) {
  const result = await api(db, capture({...source, ...changes}));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.pick;
}

loadRoster(ROSTER);

test('pick validation rejects invalid odds, dates, links and unknown sources', () => {
  assert.equal(validatePickInput(source).odds, 350);
  assert.equal(validatePickInput({...source, odds: null}).odds, null);
  assert.equal(validatePickInput({...source, eventDate: '2028-02-29', odds: -100}).odds, -100);
  for (const changes of [
    {odds: '350'}, {odds: NaN}, {odds: Infinity}, {odds: 99}, {odds: -99}, {odds: 100001}, {odds: 100.5},
    {eventDate: '2026-02-30'}, {eventDate: '2026-13-01'}, {eventDate: 'tomorrow'},
    {postedAt: '2026-02-30T12:00'}, {postedAt: '5'}, {postedAt: '2026-09-11T24:01'},
    {sourceId: 'arbitrary-source'}, {sourceUrl: 'javascript:alert(1)'},
    {sourceUrl: 'http://example.com'}, {sourceUrl: 'https://name:password@example.com'},
    {sourceUrl: 'https://example.com/\nlink'}, {originalText: '   '},
    {capturedBeforeStart: 'true'}, {sport: 'NFL', market: 'Home run'},
  ]) assert.throws(() => validatePickInput({...source, ...changes}), JSON.stringify(changes));
  assert.throws(() => validateSettlementInput({status: 'win', resultEvidence: '', resultUrl: ''}), /result note/);
  assert.equal(validateSettlementInput({status: 'review', resultEvidence: '', resultUrl: ''}).status, 'review');
});

test('fingerprints ignore tracking parameters and case but distinguish separate selections', () => {
  assert.equal(pickIdentityText(source), pickIdentityText({...source, selection: ' test player ', sourceUrl: source.sourceUrl + '?ref=test#caption'}));
  assert.notEqual(pickIdentityText(source), pickIdentityText({...source, selection: 'Another Player'}));
});

test('every picks action authenticates before private storage, limits or model access', async () => {
  for (const action of ['read', 'save', 'check', 'edit', 'settle', 'archive', 'import']) {
    const response = await worker.fetch(new Request('https://worker.example/picks', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pass: 'wrong', action}),
    }), {
      DASH_PASSPHRASE: PASS,
      get PICKS_DB() { throw new Error('Unauthenticated storage access'); },
      get LIMITS() { throw new Error('Picks must not consume assistant limits'); },
      get ANTHROPIC_API_KEY() { throw new Error('Picks must not call the model'); },
    });
    assert.equal(response.status, 401, action);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  }
});

test('picks never fall back to public writes, and all error/preflight responses stay private', async () => {
  const unavailable = await api(undefined, {action: 'read'});
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.data.error, /temporarily unavailable/);
  const failed = await api({prepare() {throw new Error('secret internal storage detail');}}, {action: 'read'});
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.data), /secret internal/);
  const deniedOrigin = await api(database(), {action: 'read'}, {headers: {origin: 'https://untrusted.example'}, env: {ALLOWED_ORIGIN: '*'}});
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), ORIGIN);
  for (const [method, expected] of [['GET', 405], ['OPTIONS', 204]]) {
    const result = await api(undefined, {}, {method});
    assert.equal(result.status, expected);
    assert.equal(result.headers.get('cache-control'), 'private, no-store');
  }
  const unsupported = await api(database(), {action: 'write_file'});
  assert.equal(unsupported.status, 400);
  assert.equal((await api(database(), {action: 'read'}, {headers: {'content-type': 'text/plain'}})).status, 415);
});

test('private capture persists evidence, incomplete alternatives need review, and tracking duplicates are rejected', async () => {
  const db = database();
  const captured = await save(db, {selection: '', event: '', eventDate: '', odds: null});
  assert.equal(captured.status, 'review');
  assert.equal(captured.originalText, source.originalText);
  assert.equal(captured.revision, 1);
  const duplicate = await api(db, capture({...source, selection: '', event: '', eventDate: '', odds: null, sourceUrl: source.sourceUrl + '?tracking=1'}));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.duplicateId, captured.id);
  const list = await api(db, {action: 'read'});
  assert.equal(list.status, 200); // No LIMITS, GITHUB_TOKEN or model key is present.
  assert.deepEqual(list.data.picks, [captured]);
  const settlement = await api(db, {action: 'settle', id: captured.id, revision: 1, status: 'win', resultEvidence: 'Test result evidence', resultUrl: ''});
  assert.equal(settlement.status, 400);
});

test('settlement requires evidence; correction preserves originals and resets the old result with history', async () => {
  const db = database(), captured = await save(db);
  const missing = await api(db, {action: 'settle', id: captured.id, revision: 1, status: 'win', resultEvidence: '', resultUrl: ''});
  assert.equal(missing.status, 400);
  const settled = await api(db, {action: 'settle', id: captured.id, revision: 1, status: 'win', resultEvidence: 'Verified test box score', resultUrl: 'https://example.com/result'});
  assert.equal(settled.status, 200);
  assert.equal(settled.data.pick.revision, 2);
  for (const change of [{originalText: 'Changed original'}, {sourceId: 'cru', accountId: account('cru', 0)}, {accountId: account('nick', 1)}, {sourceUrl: 'https://example.com/different'}]) {
    const result = await api(db, {action: 'edit', id: captured.id, revision: 2, reason: 'Attempted correction', pick: {...source, ...change}});
    assert.equal(result.status, 400);
    assert.match(result.data.error, /Original evidence stays unchanged/);
  }
  const corrected = await api(db, {action: 'edit', id: captured.id, revision: 2, reason: 'Corrected exact selection', pick: {...source, selection: 'Corrected Player'}});
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.pick.status, 'pending');
  assert.equal(corrected.data.pick.resultEvidence, '');
  assert.equal(corrected.data.pick.resultUrl, '');
  assert.equal(corrected.data.pick.originalText, captured.originalText);
  const duplicateOriginal = await api(db, capture(source));
  assert.equal(duplicateOriginal.status, 409);
  const list = (await api(db, {action: 'read'})).data;
  assert.equal(list.revisions.length, 2);
  assert.equal(JSON.parse(list.revisions.find(row => row.reason === 'Corrected exact selection').snapshot).status, 'win');
});

test('archive, restore and stale version conflicts retain the complete revision trail', async () => {
  const db = database(), captured = await save(db);
  const archived = await api(db, {action: 'archive', id: captured.id, revision: 1, archived: true});
  assert.equal(archived.status, 200);
  assert.equal(archived.data.pick.archived, true);
  const stale = await api(db, {action: 'archive', id: captured.id, revision: 1, archived: false});
  assert.equal(stale.status, 409);
  const restored = await api(db, {action: 'archive', id: captured.id, revision: 2, archived: false});
  assert.equal(restored.status, 200);
  const list = (await api(db, {action: 'read'})).data;
  assert.equal(list.picks[0].revision, 3);
  assert.equal(list.picks[0].archived, false);
  assert.equal(list.revisions.length, 2);
});

test('a writer racing after the initial read cannot overwrite the winner or create false history', async () => {
  const db = database(), captured = await save(db), rival = database(db.sqlite);
  db.beforeBatch = async () => {
    db.beforeBatch = null;
    assert.equal((await api(rival, {action: 'archive', id: captured.id, revision: 1, archived: true})).status, 200);
  };
  const loser = await api(db, {action: 'edit', id: captured.id, revision: 1, reason: 'Losing concurrent correction', pick: {...source, selection: 'Losing Player'}});
  assert.equal(loser.status, 409);
  const list = (await api(db, {action: 'read'})).data;
  assert.equal(list.picks[0].selection, source.selection);
  assert.equal(list.picks[0].archived, true);
  assert.equal(list.picks[0].revision, 2);
  assert.equal(list.revisions.length, 1);
  assert.equal(list.revisions[0].reason, 'Archived from active record');
});

test('history insertion failure rolls the mutation back instead of silently losing the audit trail', async () => {
  const db = database(), captured = await save(db);
  db.sqlite.exec("CREATE TRIGGER fail_history BEFORE INSERT ON pick_revisions BEGIN SELECT RAISE(ABORT,'test storage failure'); END;");
  const failure = await api(db, {action: 'archive', id: captured.id, revision: 1, archived: true});
  assert.equal(failure.status, 503);
  const list = (await api(db, {action: 'read'})).data;
  assert.deepEqual(list.picks, [captured]);
  assert.deepEqual(list.revisions, []);
});

test('database constraints block concurrent duplicate saves after both preflight reads succeed', async () => {
  const db = database(), rival = database(db.sqlite);
  db.beforeRun = async sql => {
    if (!sql.startsWith('INSERT INTO picks')) return;
    db.beforeRun = null;
    await save(rival);
  };
  const loser = await api(db, capture(source));
  assert.equal(loser.status, 409);
  assert.equal((await api(db, {action: 'read'})).data.picks.length, 1);
});

test('schema protects original evidence and cross-column identities even without preflight queries', async () => {
  const db = database(), captured = await save(db);
  const corrected = await api(db, {action: 'edit', id: captured.id, revision: 1, reason: 'Correct selection', pick: {...source, selection: 'Changed Player'}});
  assert.equal(corrected.status, 200);
  const row = db.sqlite.prepare('SELECT * FROM picks WHERE id=?').get(captured.id);
  assert.throws(() => db.sqlite.prepare('UPDATE picks SET data=? WHERE id=?').run(JSON.stringify({...corrected.data.pick, originalText: 'Tampered'}), captured.id), /immutable/);
  assert.throws(() => db.sqlite.prepare('INSERT INTO picks(id,owner,source_id,fingerprint,original_fingerprint,data,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('another-id', row.owner, row.source_id, row.original_fingerprint, 'a'.repeat(64), row.data, 0, 1, row.created_at, row.updated_at), /duplicate pick fingerprint/);
});

test('authenticated migration preserves IDs, timestamps, original evidence and revisions and is idempotent', async () => {
  const old = database(), captured = await save(old);
  const checked = await api(old, {action: 'check', sourceId: 'nick', status: 'Needs review', note: 'Test transcript needs review.'});
  assert.equal(checked.status, 200);
  await api(old, {action: 'edit', id: captured.id, revision: 1, reason: 'Corrected test event', pick: {...source, event: 'Corrected test matchup'}});
  const desk = (await api(old, {action: 'read'})).data, target = database();
  const imported = await api(target, {action: 'import', desk});
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.deepEqual(imported.data.imported, {picks: 1, checks: 1, revisions: 1});
  assert.deepEqual((await api(target, {action: 'read'})).data, desk);
  const repeated = await api(target, {action: 'import', desk});
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data.imported, {picks: 0, checks: 0, revisions: 0});
  assert.deepEqual(repeated.data.skipped, {picks: 1, checks: 1, revisions: 1});
  assert.equal((await api(target, capture(source))).status, 409);
  await api(target, {action: 'archive', id: captured.id, revision: 2, archived: true});
  assert.equal((await api(target, {action: 'import', desk})).status, 409);
  assert.equal((await api(target, {action: 'read'})).data.picks[0].archived, true);
});

test('invalid or conflicting imports cannot leave partial data behind', async () => {
  const old = database(), captured = await save(old), target = database();
  const desk = {picks: [captured, {...captured, id: 'another-record'}], checks: [], revisions: []};
  const duplicate = await api(target, {action: 'import', desk});
  assert.equal(duplicate.status, 409);
  assert.deepEqual((await api(target, {action: 'read'})).data.picks, []);
  const changed = {...captured, revision: 2};
  const noOriginal = await api(target, {action: 'import', desk: {...desk, picks: [changed]}});
  assert.equal(noOriginal.status, 400);
  assert.match(noOriginal.data.error, /first revision snapshot/);
  assert.deepEqual((await api(target, {action: 'read'})).data.picks, []);
});

test('a creator account is recorded only when it belongs to that creator', async () => {
  assert.equal(validatePickInput({...source, accountId: account('nick', 1)}).accountId, account('nick', 1));
  assert.equal('accountId' in validatePickInput({...source, accountId: ''}), false);
  for (const changes of [
    {accountId: account('danny', 1)},          // belongs to another creator
    {accountId: 'not-a-configured-account'},        // not a configured account
    {accountId: 'invented-handle'},
    {accountId: 7},
  ]) assert.throws(() => validatePickInput({...source, ...changes}), /belongs to this creator/, JSON.stringify(changes));
  for (const accountId of [account('danny', 0), account('danny', 1), account('danny', 2)]) {
    assert.equal(validatePickInput({...source, sourceId: 'danny', accountId}).accountId, accountId);
  }
});

test('the account is part of the original evidence and cannot be edited later', async () => {
  const db = database();
  const saved = await save(db, {sourceId: 'danny', accountId: account('danny', 2)});
  assert.equal(saved.accountId, account('danny', 2));
  assert.equal(saved.sourceId, 'danny');
  const moved = await api(db, {
    action: 'edit', id: saved.id, revision: saved.revision, reason: 'Wrong account recorded',
    pick: {...source, sourceId: 'danny', accountId: account('danny', 1)},
  });
  assert.equal(moved.status, 400);
  assert.match(moved.data.error, /Original evidence stays unchanged/);
  const kept = await api(db, {action: 'read'});
  assert.equal(kept.data.picks[0].accountId, account('danny', 2));
});

test('one creator posting the same pick from two accounts is stored once', async () => {
  const db = database();
  await save(db, {sourceId: 'danny', accountId: account('danny', 0)});
  const again = await api(db, capture({...source, sourceId: 'danny', accountId: account('danny', 1)}));
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already in your desk/);
  const stored = await api(db, {action: 'read'});
  assert.equal(stored.data.picks.length, 1);
});

test('a new capture from a creator with several accounts must name the account', async () => {
  const db = database();
  const {accountId, ...withoutAccount} = source;
  const missing = await api(db, capture(withoutAccount));
  assert.equal(missing.status, 400);
  assert.match(missing.data.error, /which of this creator's accounts/);
  assert.equal((await api(db, {action: 'read'})).data.picks.length, 0);
  // A creator with a single account, and every import or correction, is unaffected.
  const single = await api(db, capture({...withoutAccount, sourceId: 'stunad', sourceUrl: 'https://example.com/private-post/1'}));
  assert.equal(single.status, 201);
  assert.equal(single.data.pick.accountId, undefined);
  assert.equal(validatePickInput(withoutAccount).accountId, undefined);
});

// Fixture reel evidence. Invented wording for tests only; no reel was opened.
const reel = {
  sourceId: 'danny', accountId: account('danny', 1),
  sourceUrl: 'https://example.com/private-reel/1',
  medium: 'audio', engine: 'test-fixture',
  transcript: 'Give me Texans moneyline tonight. I would have to lean Bengals over 42.5.',
  transcribedAt: '2026-09-14T15:00:00Z',
};

test('reel transcripts are stored as private audio evidence and never from captions or comments', async () => {
  const db = database();
  const saved = await api(db, {action: 'transcript', transcript: reel});
  assert.equal(saved.status, 201);
  assert.equal(saved.data.transcript.transcript, reel.transcript);
  assert.equal(saved.data.transcript.medium, 'audio');
  const again = await api(db, {action: 'transcript', transcript: {...reel, transcript: 'A different pass over the same reel.'}});
  assert.equal(again.data.reused, true);
  assert.equal(again.data.transcript.transcript, reel.transcript, 'stored evidence is never rewritten');
  for (const [changes, pattern] of [
    [{medium: 'caption'}, /captions and viewer comments are not a source/],
    [{medium: 'comment'}, /captions and viewer comments are not a source/],
    [{accountId: ''}, /which of this creator's accounts/],
    [{accountId: account('nick', 1)}, /belongs to this creator/],
    [{sourceUrl: ''}, /link to the reel/],
    [{sourceUrl: 'http://example.com/reel'}, /https/],
    [{transcript: '   '}, /transcript/],
    [{transcribedAt: 'yesterday'}, /transcription time/],
  ]) {
    const result = await api(db, {action: 'transcript', transcript: {...reel, sourceUrl: reel.sourceUrl + Math.random(), ...changes}});
    assert.equal(result.status, 400, JSON.stringify(changes));
    assert.match(result.data.error, pattern, JSON.stringify(changes));
  }
  assert.equal((await api(db, {action: 'read'})).data.transcripts.length, 1);
});

test('a pick may only claim a reel it was actually spoken in', async () => {
  const db = database();
  const transcriptId = (await api(db, {action: 'transcript', transcript: reel})).data.transcript.id;
  const base = {...source, sourceId: 'danny', accountId: account('danny', 1), sport: 'NFL', market: 'Moneyline',
    selection: 'Texans moneyline', event: 'Texans at Colts', originalText: reel.transcript,
    sourceUrl: 'https://example.com/private-reel/1/post'};
  const wrongWords = await api(db, capture({...base, selection: 'Chiefs moneyline', transcriptId}));
  assert.equal(wrongWords.status, 400);
  assert.match(wrongWords.data.error, /does not appear in the creator's spoken words/);
  const wrongAccount = await api(db, capture({...base, accountId: account('danny', 2), transcriptId}));
  assert.equal(wrongAccount.status, 400);
  assert.match(wrongAccount.data.error, /belongs to a different account/);
  const unknown = await api(db, capture({...base, transcriptId: 'not-a-stored-transcript'}));
  assert.equal(unknown.status, 404);
  const good = await api(db, capture({...base, transcriptId}));
  assert.equal(good.status, 201, JSON.stringify(good.data));
  assert.equal(good.data.pick.transcriptId, transcriptId);
  assert.equal(good.data.pick.kind, undefined, 'a firm pick stores no extra key');
});

test('a lean is stored as a lean and historical picks keep no kind at all', async () => {
  const db = database();
  const transcriptId = (await api(db, {action: 'transcript', transcript: reel})).data.transcript.id;
  const lean = await api(db, capture({...source, sourceId: 'danny', accountId: account('danny', 1),
    sport: 'NFL', market: 'Total', selection: 'Bengals over 42.5', event: 'Bengals at Buccaneers',
    originalText: reel.transcript, sourceUrl: 'https://example.com/private-reel/1/lean',
    transcriptId}, 'lean'));
  assert.equal(lean.status, 201, JSON.stringify(lean.data));
  assert.equal(lean.data.pick.kind, 'lean');
  assert.throws(() => validatePickInput({...source, kind: 'probably'}), /firm or lean/);
  const historical = await save(db);
  assert.equal(historical.kind, undefined);
  assert.equal(historical.transcriptId, undefined);
  const reread = (await api(db, {action: 'read'})).data.picks.find(row => row.id === historical.id);
  assert.equal('kind' in reread, false, 'a historical pick is not rewritten with a kind');
  assert.equal('transcriptId' in reread, false);
});

test('without the roster secret the picks path refuses every action', async () => {
  const db = database();
  for (const PICKS_ROSTER of [undefined, '', '   ']) {
    const result = await api(db, {action: 'read'}, {env: {PICKS_ROSTER}});
    assert.equal(result.status, 503);
    assert.match(result.data.error, /roster secret is not configured/);
  }
  for (const [secret, pattern] of [
    ['not json', /not valid JSON/],
    ['[]', /holds no creators/],
    ['[{"id":"Bad Id","name":"x","accounts":[{"id":"a","platform":"X","url":"https://example.com"}]}]', /creator id is invalid/],
    ['[{"id":"a","name":"","accounts":[{"id":"a1","platform":"X","url":"https://example.com"}]}]', /has no name/],
    ['[{"id":"a","name":"A","accounts":[]}]', /has no accounts/],
    ['[{"id":"a","name":"A","accounts":[{"id":"a1","platform":"X","url":"http://example.com"}]}]', /no https link/],
    ['[{"id":"a","name":"A","accounts":[{"id":"a1","platform":"X","url":"https://example.com"}]},{"id":"a","name":"B","accounts":[{"id":"b1","platform":"X","url":"https://example.com"}]}]', /creator id is repeated/],
  ]) {
    const result = await api(db, {action: 'read'}, {env: {PICKS_ROSTER: secret}});
    assert.equal(result.status, 503, secret);
    assert.match(result.data.error, pattern, secret);
  }
  // A bad secret never leaves a partial roster behind for the next request.
  const good = await api(db, {action: 'read'});
  assert.equal(good.status, 200);
  assert.equal(good.data.roster.length, JSON.parse(ROSTER).length);
});

test('the tracked Worker source carries no roster values of its own', async () => {
  const worker = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
  for (const creator of JSON.parse(ROSTER)) {
    assert.equal(worker.includes(creator.name), false, `worker.js names ${creator.id}`);
    for (const account of creator.accounts) {
      assert.equal(worker.includes(account.url), false, 'worker.js holds an account link');
      assert.equal(worker.includes(account.id), false, 'worker.js holds an account id');
    }
  }
});

test('the roster is served only to an authenticated read, exactly as configured', async () => {
  const db = database();
  const locked = await api(db, {action: 'read'}, {headers: {}, env: {DASH_PASSPHRASE: 'a-different-passphrase'}});
  assert.equal(locked.status, 401);
  assert.equal(locked.data.roster, undefined, 'a locked request must learn no creator');
  assert.equal(JSON.stringify(locked.data).includes('example.com'), false);
  const opened = await api(db, {action: 'read'});
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.data.roster, ROSTER_LIST, 'the read mirrors the configured roster');
  // Validation is driven by the configured roster, not by anything baked into the code.
  assert.equal(validatePickInput({...source, sourceId: 'danny', accountId: account('danny', 2)}).accountId, account('danny', 2));
  assert.throws(() => validatePickInput({...source, sourceId: 'not-in-this-roster'}), /a configured source/);
});

test('a new capture is refused unless its own source link was reopened first', async () => {
  const db = database();
  const bare = await api(db, {action: 'save', pick: source});
  assert.equal(bare.status, 400);
  assert.match(bare.data.error, /Reopen this pick's source link once before saving/);
  const wrongLink = await api(db, {...capture(source), verification: {
    outcome: 'firm', reason: '', checkedUrl: 'https://example.com/a-different-post', checkedAt: '2026-09-13T12:30:00Z'}});
  assert.equal(wrongLink.status, 400);
  assert.match(wrongLink.data.error, /does not match/);
  for (const [changes, pattern] of [
    [{outcome: 'probably'}, /firm, lean, or unclear/],
    [{outcome: 'unclear', reason: ''}, /could not be confirmed/],
    [{checkedUrl: ''}, /exact source link/],
    [{checkedUrl: 'http://example.com/channels/1/2/3'}, /https/],
    [{checkedAt: 'earlier today'}, /recheck time/],
  ]) {
    const result = await api(db, {...capture(source), verification: {
      outcome: 'firm', reason: '', checkedUrl: source.sourceUrl, checkedAt: '2026-09-13T12:30:00Z', ...changes}});
    assert.equal(result.status, 400, JSON.stringify(changes));
    assert.match(result.data.error, pattern, JSON.stringify(changes));
  }
  assert.equal((await api(db, {action: 'read'})).data.picks.length, 0, 'nothing is saved without the recheck');
});

test('the reopened post decides the record, and the recheck is kept with it', async () => {
  const db = database();
  const complete = {...source, event: 'Test Away at Test Home', eventDate: '2026-09-13'};
  const firm = await api(db, capture({...complete, sourceUrl: 'https://example.com/post/firm'}, 'firm'));
  assert.equal(firm.status, 201);
  assert.equal(firm.data.pick.status, 'pending', 'a confirmed firm call is saved ready to count');
  assert.equal(firm.data.pick.kind, undefined);
  assert.deepEqual(firm.data.pick.verification, {
    outcome: 'firm', reason: '', checkedAt: '2026-09-13T12:30:00Z', checkedUrl: 'https://example.com/post/firm'});

  const lean = await api(db, capture({...complete, sourceUrl: 'https://example.com/post/lean'}, 'lean'));
  assert.equal(lean.data.pick.kind, 'lean', 'qualified wording is saved as a lean');
  assert.equal(lean.data.pick.status, 'pending');

  const unclear = await api(db, capture({...complete, sourceUrl: 'https://example.com/post/unclear'}, 'unclear', 'Post is no longer visible on the account.'));
  assert.equal(unclear.data.pick.status, 'review', 'an unclear post saves for review');
  assert.equal(unclear.data.pick.verification.reason, 'Post is no longer visible on the account.');

  // An incomplete pick stays in review whatever the wording showed.
  const thin = await api(db, capture({...source, event: '', sourceUrl: 'https://example.com/post/thin'}, 'firm'));
  assert.equal(thin.data.pick.status, 'review');
});

test('the intake rule never touches historical records', async () => {
  const db = database();
  const saved = (await api(db, capture({...source, event: 'Test Away at Test Home'}, 'firm'))).data.pick;
  // A correction carries no recheck and is accepted; the original one is preserved.
  const corrected = await api(db, {action: 'edit', id: saved.id, revision: saved.revision,
    reason: 'Corrected exact selection', pick: {...source, event: 'Test Away at Test Home', selection: 'Corrected Player'}});
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.deepEqual(corrected.data.pick.verification, saved.verification);
  // An import of records that predate the rule is accepted with no recheck at all.
  const legacy = {...saved, id: 'legacy-record', selection: 'Legacy Player', sourceUrl: 'https://example.com/legacy', fingerprintless: undefined};
  delete legacy.verification;
  const target = database();
  const imported = await api(target, {action: 'import', desk: {picks: [legacy], checks: [], revisions: []}});
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const stored = (await api(target, {action: 'read'})).data.picks[0];
  assert.equal('verification' in stored, false, 'a historical record gains nothing');
  assert.equal('kind' in stored, false);
});

// A separate, revocable secret for the scheduled task. Test value only.
const AGENT = 'test-automation-token-0123456789abcdef';

test('the automation token authenticates without the passphrase and only for its own actions', async () => {
  const db = database();
  const asAgent = (body, token = AGENT) => api(db, {...body, agentToken: token}, {env: {PICKS_AGENT_TOKEN: AGENT}, agent: true});
  const opened = await asAgent({action: 'read'});
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.equal(opened.data.roster.length, ROSTER_LIST.length);
  const complete = {...source, event: 'Test Away at Test Home', sourceUrl: 'https://example.com/agent/1'};
  const saved = await asAgent(capture(complete, 'firm'));
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal((await asAgent({action: 'check', sourceId: 'nick', status: 'Checked', note: 'Scheduled pass.'})).status, 200);

  // Everything that could reach an existing record is refused for the token.
  for (const body of [
    {action: 'edit', id: saved.data.pick.id, revision: 1, reason: 'Attempted correction', pick: complete},
    {action: 'settle', id: saved.data.pick.id, revision: 1, status: 'win', resultEvidence: 'x', resultUrl: ''},
    {action: 'archive', id: saved.data.pick.id, revision: 1, archived: true},
    {action: 'import', desk: {picks: [], checks: [], revisions: []}},
  ]) {
    const refused = await asAgent(body);
    assert.equal(refused.status, 403, body.action);
    assert.match(refused.data.error, /need the dashboard passphrase/, body.action);
  }
  const untouched = (await asAgent({action: 'read'})).data.picks.find(row => row.id === saved.data.pick.id);
  assert.equal(untouched.revision, 1, 'no existing record moved');
  assert.equal(untouched.status, 'pending');
});

test('a scheduled run is verified only by a final receipt that accounts for every configured account', async () => {
  const db = database();
  const asAgent = body => api(db, {...body, agentToken: AGENT}, {env: {PICKS_AGENT_TOKEN: AGENT}, agent: true});
  const accountCount = ROSTER_LIST.reduce((total, creator) => total + creator.accounts.length, 0);
  const partial = await asAgent({action:'receipt', receipt:{outcome:'complete', accountsChecked:accountCount - 1, accountsBlocked:0, picksSaved:0, checksSaved:0, note:'', startedAt:'2026-09-15T15:00:00Z'}});
  assert.equal(partial.status, 400);
  const saved = await asAgent({action:'receipt', receipt:{outcome:'no_work', accountsChecked:accountCount, accountsBlocked:0, picksSaved:0, checksSaved:accountCount, note:'All configured accounts checked; no new picks.', startedAt:'2026-09-15T15:00:00Z'}});
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const desk = (await asAgent({action:'read'})).data;
  assert.equal(desk.latestRun.outcome, 'no_work');
  assert.equal(desk.latestRun.accountsChecked, accountCount);
  const blocked = await asAgent({action:'receipt', receipt:{outcome:'blocked', accountsChecked:0, accountsBlocked:accountCount, picksSaved:0, checksSaved:0, note:'The local bridge was unavailable.', startedAt:'2026-09-15T21:00:00Z'}});
  assert.equal(blocked.status, 201);
  assert.equal((await asAgent({action:'read'})).data.latestRun.outcome, 'blocked');
});

test('a wrong, short, or unset automation secret grants nothing', async () => {
  const db = database();
  for (const [env, token] of [
    [{PICKS_AGENT_TOKEN: AGENT}, 'the-wrong-token-0123456789abcdefg'],
    [{PICKS_AGENT_TOKEN: AGENT}, AGENT.slice(0, -1)],
    [{PICKS_AGENT_TOKEN: AGENT}, ''],
    [{PICKS_AGENT_TOKEN: 'too-short-to-be-a-secret'}, 'too-short-to-be-a-secret'],
    [{PICKS_AGENT_TOKEN: ''}, ''],
    [{}, AGENT],
  ]) {
    const result = await api(db, {action: 'read', agentToken: token}, {env, agent: true});
    assert.equal(result.status, 401, JSON.stringify({token, env}));
    assert.equal(result.data.roster, undefined, 'a rejected caller learns no creator');
  }
});

test('the passphrase flow is unchanged and still has full access', async () => {
  const db = database();
  const saved = await save(db);
  assert.equal((await api(db, {action: 'archive', id: saved.id, revision: 1, archived: true})).status, 200);
  assert.equal((await api(db, {action: 'read'})).status, 200);
  // A passphrase request is never affected by the automation secret's presence.
  assert.equal((await api(db, {action: 'read'}, {env: {PICKS_AGENT_TOKEN: AGENT}})).status, 200);
  // And a bad passphrase is still refused even when a valid token exists elsewhere.
  const wrong = await api(db, {action: 'read'}, {env: {DASH_PASSPHRASE: 'a-different-passphrase', PICKS_AGENT_TOKEN: AGENT}});
  assert.equal(wrong.status, 401);
});
