// sys/assistant-sessions.js against real sqlite3 databases made from Hermes 0.17.0's schema (hermes_state.py
// SCHEMA_SQL, the sessions and messages tables): Hermes's own ACP listing (core/assistant-list.js SESSIONS_SQL), the
// immutable retry for a WAL database Hermes closed cleanly (spike S9), a database missing a column (`schema`), the
// profiles and the folder's files for the @ menu. Read-only: nothing here touches ~/.hermes.
import { test } from 'node:test'; import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process'; import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'; import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { querySessions, queryResult, profileSessions, listProfiles, profileNames, listFolderFiles, folderFileList, SQLITE } from '../mods/lazuli/sys/assistant-sessions.js';
import { buildList, SESSIONS_SQL } from '../mods/lazuli/core/assistant-list.js';

/** Herdr's `exec` contract in Node: `{code, stdout, stderr}` for any exit, a rejection when the program cannot start. */
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: opts.timeout, maxBuffer: 64 << 20, encoding: 'utf8' }, (err, stdout, stderr) => {
  if (err && typeof err.code !== 'number') return reject(err);
  resolve({ code: err ? err.code : 0, stdout, stderr });
}));
const sql = (db, text) => execFileSync(SQLITE, [db], { input: text, encoding: 'utf8' });

// hermes_state.py SCHEMA_SQL (Hermes 0.17.0): the two tables the listing reads. `extra` adds the columns of a newer
// (gateway) Hermes's sessions table.
const SESSIONS = (drop = [], extra = []) => `CREATE TABLE sessions (
 ${[
  'id TEXT PRIMARY KEY', 'source TEXT NOT NULL', 'user_id TEXT', 'model TEXT', 'model_config TEXT', 'system_prompt TEXT', 'parent_session_id TEXT',
  'started_at REAL NOT NULL', 'ended_at REAL', 'end_reason TEXT', 'message_count INTEGER DEFAULT 0', 'tool_call_count INTEGER DEFAULT 0',
  'input_tokens INTEGER DEFAULT 0', 'output_tokens INTEGER DEFAULT 0', 'cache_read_tokens INTEGER DEFAULT 0', 'cache_write_tokens INTEGER DEFAULT 0',
  'reasoning_tokens INTEGER DEFAULT 0', 'cwd TEXT', 'billing_provider TEXT', 'billing_base_url TEXT', 'billing_mode TEXT', 'estimated_cost_usd REAL',
  'actual_cost_usd REAL', 'cost_status TEXT', 'cost_source TEXT', 'pricing_version TEXT', 'title TEXT', 'api_call_count INTEGER DEFAULT 0',
  'handoff_state TEXT', 'handoff_platform TEXT', 'handoff_error TEXT', 'rewind_count INTEGER NOT NULL DEFAULT 0', 'archived INTEGER NOT NULL DEFAULT 0',
].filter((c) => !drop.includes(c.split(' ')[0])).concat(extra).join(',\n ')},
 FOREIGN KEY (parent_session_id) REFERENCES sessions(id));
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT,
 tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
 reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT, codex_message_items TEXT, platform_message_id TEXT,
 observed INTEGER DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0);`;

const F = '/tmp/lz-sql-folder';
const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const SEED = `
INSERT INTO sessions (id, source, model, model_config, started_at, message_count, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, estimated_cost_usd, cost_status, api_call_count, title, archived, parent_session_id) VALUES
 ('${id(1)}','acp','gpt-5.5','{"cwd": "${F}", "provider": "openai-codex"}',1795000000,2,0,0,0,0,NULL,NULL,0,NULL,0,NULL),
 ('${id(2)}','acp','gpt-5.5','{"cwd": "${F}/"}',1795000100,1,100,50,20,5,0.01,'estimated',1,'Named session',0,NULL),
 ('${id(3)}','cli','gpt-5.5','{"cwd": "${F}"}',1795000150,1,0,0,0,0,NULL,NULL,0,NULL,0,NULL),
 ('${id(4)}','acp','gpt-5.5','{"cwd": "${F}"}',1795000160,1,0,0,0,0,NULL,NULL,0,NULL,1,NULL),
 ('${id(5)}','acp','gpt-5.5','{"cwd": "${F}"}',1795000170,0,0,0,0,0,NULL,NULL,0,NULL,0,NULL),
 ('${id(6)}','acp','gpt-5.5','{"cwd": "${F}", "_delegate_from": "${id(1)}"}',1795000180,1,0,0,0,0,NULL,NULL,0,NULL,0,'${id(1)}'),
 ('${id(7)}','acp','gpt-5.5','{"cwd": "${F}", "_branched_from": "${id(1)}"}',1795000200,1,0,0,0,0,NULL,NULL,0,NULL,0,'${id(1)}'),
 ('${id(8)}','acp','gpt-5.5','not json',1795000300,1,0,0,0,0,NULL,NULL,0,NULL,0,NULL),
 ('${id(9)}','acp','gpt-5.5','{"cwd": "/tmp/elsewhere"}',1795000050,1,0,0,0,0,NULL,NULL,0,NULL,0,NULL);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
 ('${id(1)}','user','First question
 on two lines',1795000050),
 ('${id(1)}','assistant','An answer',1795000060),
 ('${id(8)}','user','malformed',1795000310);`;

async function makeDb(dir, name, { drop = [], extra = [], seed = SEED } = {}) {
  const db = join(dir, name);
  sql(db, `PRAGMA journal_mode=WAL;\n${SESSIONS(drop, extra)}\n${seed}`);
  return db;
}

/** The listing's rows of SEED, checked whichever way the database was read. */
function checkRows(rows) {
  assert.deepEqual(rows.map((x) => x.id), [id(8), id(7), id(2), id(1), id(9)], 'newest first; cli, archived, empty and delegate rows left out');
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
  assert.equal(byId[id(1)].title, 'First question  on two lines', 'title falls back to the first user message');
  assert.equal(byId[id(1)].updatedAt, 1795000060000); assert.equal(byId[id(1)].startedAt, 1795000000000); assert.equal(byId[id(1)].messageCount, 2);
  assert.equal(byId[id(2)].title, 'Named session'); assert.equal(byId[id(2)].cwd, `${F}/`); assert.equal(byId[id(2)].model, 'gpt-5.5');
  assert.deepEqual(byId[id(2)].stats, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 5, estimatedCostUsd: 0.01, actualCostUsd: null, costStatus: 'estimated', apiCallCount: 1 });
  assert.equal(byId[id(8)].cwd, null, 'model_config that is not JSON gives no cwd');
  // The folder filter runs in JS (core/assistant-list.js): a trailing slash is the same folder; another folder is not.
  const list = buildList({ folder: F, home: '/Users/x', profiles: [{ profile: 'default', rows }] });
  assert.deepEqual(list.groups[0].rows.map((x) => x.sessionId), [id(7), id(2), id(1)]);
}

test('Hermes\'s ACP listing from a WAL database Hermes\'s schema made: while Hermes holds it, and after a clean close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-sql-'));
  let holder = null;
  try {
    const db = await makeDb(dir, 'state.db');
    assert.match(sql(db, 'PRAGMA journal_mode;'), /wal/);
    // Hermes running: a connection holds the database, so -wal and -shm exist and a read-only open reads it.
    holder = spawn(SQLITE, [db], { stdio: ['pipe', 'pipe', 'pipe'] });
    const opened = once(holder.stdout, 'data');
    holder.stdin.write('SELECT count(*) FROM sessions;\n');
    await opened;
    assert.ok(existsSync(`${db}-wal`) && existsSync(`${db}-shm`), 'an open connection keeps -wal and -shm');
    const live = await querySessions(run, db);
    assert.ok(!live.error, JSON.stringify(live));
    assert.equal(live.via, 'readonly');
    checkRows(live.rows);
    holder.stdin.end();
    await once(holder, 'exit');
    holder = null;
    // Hermes closed it cleanly (S9): no -wal and no -shm, so a read-only open fails with (14) and the listing reads
    // it with immutable=1. Whether the sqlite3 CLI removes them on close differs by build, so they are removed here.
    for (const ext of ['-wal', '-shm']) await rm(`${db}${ext}`, { force: true });
    const closed = await querySessions(run, db);
    assert.ok(!closed.error, JSON.stringify(closed));
    assert.equal(closed.via, 'immutable');
    checkRows(closed.rows);
    // Nothing was written: the read made no -wal or -shm.
    assert.ok(!existsSync(`${db}-wal`) && !existsSync(`${db}-shm`));
  } finally {
    holder?.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});

test('a database without a column the listing reads is a schema error; a missing file has no sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-sql-'));
  try {
    const old = await makeDb(dir, 'old.db', { drop: ['api_call_count'], seed: `INSERT INTO sessions (id, source, started_at, message_count) VALUES ('${id(1)}','acp',1795000000,1);` });
    const r = await querySessions(run, old);
    assert.equal(r.error, 'schema', JSON.stringify(r)); assert.match(r.detail, /api_call_count/);
    assert.deepEqual(await querySessions(run, join(dir, 'none.db')), { rows: [], via: 'absent' });
    assert.equal((await querySessions(run, 'relative.db')).error, 'failed');
    // A profile's database: ~/.hermes/state.db for default, ~/.hermes/profiles/<p>/state.db otherwise.
    await mkdir(join(dir, '.hermes', 'profiles', 'work'), { recursive: true });
    await makeDb(join(dir, '.hermes', 'profiles', 'work'), 'state.db');
    assert.equal((await profileSessions(run, dir, 'work')).rows.length, 5);
    assert.deepEqual(await profileSessions(run, dir, 'default'), { rows: [], via: 'absent' });
    assert.equal((await profileSessions(run, dir, 'Bad Name')).error, 'failed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('error (14) with no -wal file is read again with immutable=1; with a -wal file it is not', async () => {
  const stub = (wal) => {
    const calls = [];
    const fn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === '/bin/test') return { code: args[1].endsWith('-wal') ? (wal ? 0 : 1) : 0, stdout: '', stderr: '' };
      if (args[2].startsWith('file:')) return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'Parse error near line 1: unable to open database file (14)' };
    };
    return { fn, calls };
  };
  const a = stub(false);
  assert.deepEqual(await querySessions(a.fn, '/x/state?#%.db'), { rows: [], via: 'immutable' });
  const uri = a.calls.find((c) => c[0] === SQLITE && c[3].startsWith('file:'));
  assert.deepEqual(uri.slice(1, 3), ['-readonly', '-json']); assert.equal(uri[3], 'file:/x/state%3F%23%25.db?immutable=1');
  const b = stub(true);
  assert.equal((await querySessions(b.fn, '/x/state.db')).error, 'open');
  assert.ok(!b.calls.some((c) => c[0] === SQLITE && c[3].startsWith('file:')), 'no immutable read while -wal holds pages');
  // A program that cannot start is a failure, not a crash.
  assert.equal((await querySessions(async (cmd) => { if (cmd === '/bin/test') return { code: 0 }; throw new Error('program not found'); }, '/x/state.db')).error, 'failed');
});

test('query results are classified', () => {
  assert.deepEqual(queryResult({ code: 0, stdout: '' }), { rows: [] });
  assert.equal(queryResult({ code: 0, stdout: '{"a":1}' }).error, 'parse');
  assert.equal(queryResult({ code: 1, stderr: 'Error: no such table: sessions' }).error, 'schema');
  assert.equal(queryResult({ code: 1, stderr: 'Error: database is locked (5)' }).error, 'locked');
  assert.equal(queryResult({ code: 1, stderr: 'Error: unable to open database file (14)' }).error, 'open');
  assert.equal(queryResult({ code: 1, stderr: 'boom' }).error, 'failed');
});

// A gateway Hermes's editor threads (AT-25): `source='local'`, id `local-<64 hex>`, cwd in the `cwd` column only.
const LID = (c) => `local-${c.repeat(64)}`;
const OWN = LID('3'), OTHER = LID('a'), MOVED = LID('b'), EMPTY = LID('c'), ARCHIVED = LID('d'), CLI = LID('e');
const GATEWAY = ['created_source TEXT', 'hidden INTEGER NOT NULL DEFAULT 0', 'last_activity_at REAL'];
const LOCAL_SEED = `${SEED}
INSERT INTO sessions (id, source, model, model_config, cwd, started_at, message_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, cost_status, api_call_count, title, archived) VALUES
 ('${OWN}','local','claude-opus-5-5','{"provider": "anthropic"}','${F}',1795000400,10,18,2903,67687,19317,0.1682544,'estimated',5,NULL,0),
 ('${OTHER}','local','claude-opus-5-5','{}','${F}',1795000500,3,1,1,0,0,0.5,'estimated',1,'Another editor',0),
 ('${MOVED}','local','claude-opus-5-5','{}','/tmp/elsewhere',1795000450,2,0,0,0,0,NULL,NULL,0,'Moved',0),
 ('${EMPTY}','local','claude-opus-5-5','{}','${F}',1795000460,0,0,0,0,0,NULL,NULL,0,NULL,0),
 ('${ARCHIVED}','local','claude-opus-5-5','{}','${F}',1795000470,1,0,0,0,0,NULL,NULL,0,NULL,1),
 ('${CLI}','cli','claude-opus-5-5','{}','${F}',1795000480,1,0,0,0,0,NULL,NULL,0,NULL,0);
INSERT INTO messages (session_id, role, content, timestamp) VALUES
 ('${OWN}','user','Delete the scratch folder',1795000401),
 ('${OWN}','assistant','Done',1795000420),
 ('${OTHER}','user','Not ours',1795000501);`;
/** sqlite3 runs counted, for the legacy path that must stay one query. */
const counting = () => {
  const calls = [];
  return { calls, fn: (cmd, args, opts) => { if (cmd === SQLITE) calls.push(args[3]); return run(cmd, args, opts); } };
};

test('owned local sessions are read by id next to the ACP listing; other local chats are not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-sql-'));
  try {
    for (const [name, extra] of [['legacy.db', []], ['gateway.db', GATEWAY]]) {
      const db = await makeDb(dir, name, { extra, seed: LOCAL_SEED });
      const r = await querySessions(run, db, [OWN, MOVED, EMPTY, ARCHIVED, CLI, id(1), 'local-x']);
      assert.ok(!r.error, JSON.stringify(r));
      assert.deepEqual(r.rows.map((x) => x.id), [id(8), id(7), id(2), id(1), id(9), ARCHIVED, MOVED, OWN], `${name}: ACP rows as before, then the owned ones with messages, newest first`);
      assert.deepEqual(r.rows.filter((x) => x.archived).map((x) => x.id), [ARCHIVED], 'an archived one is flagged, so it is not taken for one not saved yet');
      const own = r.rows.find((x) => x.id === OWN);
      assert.deepEqual([own.title, own.cwd, own.messageCount, own.updatedAt], ['Delete the scratch folder', F, 10, 1795000420000], 'cwd from the column');
      assert.deepEqual(own.stats, { inputTokens: 18, outputTokens: 2903, cacheReadTokens: 67687, cacheWriteTokens: 19317, reasoningTokens: 0, estimatedCostUsd: 0.1682544, actualCostUsd: null, costStatus: 'estimated', apiCallCount: 5 });
      // The folder filter and the ownership rule (core/assistant-list.js): the moved one is in another folder now, the
      // archived one stays out.
      const owned = { v: 1, sessions: [OWN, MOVED, ARCHIVED].map((session) => ({ profile: 'default', folder: F, session, at: 1 })) };
      const list = buildList({ folder: F, home: '/Users/x', profiles: [{ profile: 'default', rows: r.rows }], owned });
      assert.deepEqual(list.groups[0].rows.map((x) => x.sessionId), [OWN, id(7), id(2), id(1)]);
      assert.equal(list.groups[0].rows[0].stats.estimatedCostUsd, 0.1682544);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a legacy database is read with the one ACP query unless a local id is owned; then 0.17.0 columns suffice', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-sql-'));
  try {
    const db = await makeDb(dir, 'state.db'); // Hermes 0.17.0's schema, ACP rows only
    // Whichever way it is opened (readonly, or immutable after a clean close), only SESSIONS_SQL runs.
    const extraQueries = (c) => c.calls.filter((text) => text !== SESSIONS_SQL);
    for (const owned of [undefined, [], [id(1)], ['local-x']]) {
      const c = counting();
      const r = await querySessions(c.fn, db, owned);
      checkRows(r.rows);
      assert.deepEqual(extraQueries(c), [], JSON.stringify(owned));
    }
    const c = counting();
    checkRows((await querySessions(c.fn, db, [OWN])).rows);
    assert.equal(extraQueries(c).length, 1, 'the owned query finds nothing in a 0.17.0 database and fails on none of its columns');
    // Older than 0.17.0 (no cwd column): the ACP listing reads as before; an owned query cannot.
    const old = await makeDb(dir, 'old.db', { drop: ['cwd'] });
    checkRows((await querySessions(run, old)).rows);
    assert.equal((await querySessions(run, old, [OWN])).error, 'schema');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('local chats never consume the ACP listing\'s LIMIT, and owned ones are not cut by it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-sql-'));
  try {
    const db = await makeDb(dir, 'state.db', { extra: GATEWAY, seed: `${LOCAL_SEED}
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1100)
INSERT INTO sessions (id, source, model_config, cwd, started_at, message_count) SELECT printf('ffffffff-0000-4000-8000-%012d', i), 'acp', '{"cwd": "${F}"}', NULL, 1794000000 + i, 1 FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500)
INSERT INTO sessions (id, source, model_config, cwd, started_at, message_count) SELECT printf('local-%064x', i), 'local', '{}', '${F}', 1796000000 + i, 1 FROM n;` });
    const plain = await querySessions(run, db);
    assert.equal(plain.rows.length, 1000);
    assert.ok(plain.rows.every((x) => !x.id.startsWith('local-')));
    const r = await querySessions(run, db, [OWN]);
    assert.equal(r.rows.length, 1001);
    assert.deepEqual(r.rows.slice(0, 1000).map((x) => x.id), plain.rows.map((x) => x.id), 'the same ACP rows, newer local chats left out');
    assert.equal(r.rows[1000].id, OWN, 'the owned chat is read outside that LIMIT');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the owned query reads the target the listing read, and its failure is the result', async () => {
  const stub = (failOwned) => {
    const calls = [];
    const fn = async (cmd, args) => {
      if (cmd === '/bin/test') return { code: args[1].endsWith('-wal') ? 1 : 0, stdout: '', stderr: '' };
      calls.push([args[2], args[3] === SESSIONS_SQL ? 'acp' : 'owned']);
      if (!args[2].startsWith('file:')) return { code: 1, stdout: '', stderr: 'unable to open database file (14)' };
      if (args[3] !== SESSIONS_SQL && failOwned) return { code: 1, stdout: '', stderr: 'Error: database is locked (5)' };
      return { code: 0, stdout: args[3] === SESSIONS_SQL ? '' : JSON.stringify([{ id: OWN, cwd: F, message_count: 1, started_at: 1 }]), stderr: '' };
    };
    return { fn, calls };
  };
  const a = stub(false);
  const r = await querySessions(a.fn, '/x/state.db', [OWN]);
  assert.deepEqual([r.via, r.rows.map((x) => x.id)], ['immutable', [OWN]]);
  assert.deepEqual(a.calls, [['/x/state.db', 'acp'], ['file:/x/state.db?immutable=1', 'acp'], ['file:/x/state.db?immutable=1', 'owned']]);
  assert.equal((await querySessions(stub(true).fn, '/x/state.db', [OWN])).error, 'locked');
});

test('profiles: default first, then valid profile folders by name', async () => {
  assert.deepEqual(profileNames('/h/.hermes/profiles/work\n/h/.hermes/profiles/Bad Name\n/h/.hermes/profiles/.hidden\n/h/.hermes/profiles/docs/\n/h/.hermes/profiles/default\n'), ['default', 'docs', 'work']);
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-profiles-'));
  try {
    assert.deepEqual(await listProfiles(run, dir), ['default'], 'no ~/.hermes/profiles');
    for (const p of ['work', 'Bad Name', '.hidden', 'docs', 'a_b-c']) await mkdir(join(dir, '.hermes', 'profiles', p), { recursive: true });
    await writeFile(join(dir, '.hermes', 'profiles', 'file'), 'x');
    assert.deepEqual(await listProfiles(run, dir), ['default', 'a_b-c', 'docs', 'work']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the folder\'s files for @: images, hidden entries and dependency folders left out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-files-'));
  try {
    const put = async (rel, text = 'x') => { await mkdir(join(dir, rel, '..'), { recursive: true }); await writeFile(join(dir, rel), text); };
    for (const rel of ['notes.md', 'todo.txt', 'sub/plan.md', 'scratch/dummy.txt', 'pic.png', 'photo.JPG', 'icon.svg', '.hidden.md', '.git/config', 'node_modules/x/index.js', 'sub/.cache/y.txt']) await put(rel);
    assert.deepEqual(await listFolderFiles(run, dir), ['icon.svg', 'notes.md', 'todo.txt', 'scratch/dummy.txt', 'sub/plan.md']);
    assert.deepEqual(await listFolderFiles(run, join(dir, 'missing')), []);
    assert.deepEqual(await listFolderFiles(run, 'relative'), []);
    assert.deepEqual(folderFileList(`/f/a.md\0/f/b/c.gif\0/elsewhere/x.md\0/f/z/y.txt\0`, '/f/'), ['a.md', 'z/y.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
