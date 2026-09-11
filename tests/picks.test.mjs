import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

const code = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const schema = await readFile(new URL('../schema-picks.sql', import.meta.url), 'utf8');
const {default: worker, validatePickInput, validateSettlementInput, pickIdentityText} =
  await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const ORIGIN = 'https://ppitchford02.github.io';
const PASS = 'only-used-in-tests';
const source = {
  sourceId: 'nick', sport: 'MLB', market: 'Home run', selection: 'Test Player',
  event: 'Test Away at Test Home', eventDate: '2026-09-11', odds: 350,
  postedAt: '2026-09-11T09:30', sourceUrl: 'https://discord.com/channels/1/2/3',
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
    ...(options.method && options.method !== 'POST' ? {} : {body: JSON.stringify({pass: PASS, ...body})}),
  });
  const response = await worker.fetch(request, {DASH_PASSPHRASE: PASS, PICKS_DB: db, ...options.env});
  const data = response.status === 204 ? null : await response.json();
  return {status: response.status, data, headers: response.headers};
}

async function save(db, changes = {}) {
  const result = await api(db, {action: 'save', pick: {...source, ...changes}});
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.pick;
}

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
  const duplicate = await api(db, {action: 'save', pick: {...source, selection: '', event: '', eventDate: '', odds: null, sourceUrl: source.sourceUrl + '?tracking=1'}});
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
  for (const change of [{originalText: 'Changed original'}, {sourceId: 'cru'}, {sourceUrl: 'https://example.com/different'}]) {
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
  const duplicateOriginal = await api(db, {action: 'save', pick: source});
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
  const loser = await api(db, {action: 'save', pick: source});
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
  assert.equal((await api(target, {action: 'save', pick: source})).status, 409);
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
