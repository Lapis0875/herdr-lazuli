import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  SESSIONS_SQL, mapRows, mapSessionList, normalizeCwd, buildList, normalizeUi, pruneUi, isProfileName, isSessionId, sessionKey, parseKey,
  firmlinkShort, pathsToResolve, isLocalSessionId, ownedSessionsSql, normalizeOwned, addOwned, ownedIds, OWNED_MAX, dropOwned, heldSelection,
} from '../mods/lazuli/core/assistant-list.js';
import { resolvePaths, shortFolder } from '../mods/lazuli/sys/assistant-sessions.js';

const HOME = '/Users/u';
const FOLDER = '/Users/u/work/notes';
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A SESSIONS_SQL row as `sqlite3 -json` prints it (docs/spikes/S9.md).
const ROW = (o = {}) => ({
  id: sid(1), title: null, preview: '', cwd: FOLDER, model: 'gpt-5.5', message_count: 2, started_at: 1795386035.692066, last_active: 1795386044.5,
  input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
  estimated_cost_usd: 0.01, actual_cost_usd: null, cost_status: 'estimated', api_call_count: 1, ...o,
});
// Mapped rows, as buildList takes them.
const rowsIn = (n, cwd = FOLDER, start = 1) => Array.from({ length: n }, (_, i) => ({
  id: sid(start + i), title: `s${start + i}`, cwd, model: 'gpt-5.5', messageCount: 2, startedAt: 1000 * (start + i), updatedAt: 1000 * (start + i), stats: null,
}));
const list = (o) => buildList({ folder: FOLDER, home: HOME, ...o });

test('SESSIONS_SQL is the query validated in S9', () => {
  const file = readFileSync(new URL('../docs/spikes/S9/sessions.sql', import.meta.url), 'utf8');
  assert.equal(SESSIONS_SQL.trim(), file.trim());
  for (const part of ["s.source = 'acp'", 's.message_count > 0', 's.archived = 0', "json_extract(s.model_config, '$.cwd')", 's.api_call_count', 's.estimated_cost_usd']) {
    assert.ok(SESSIONS_SQL.includes(part), part);
  }
});

test('mapRows reads sqlite3 -json output', () => {
  assert.deepEqual(mapRows(''), []); // sqlite3 -json prints nothing for zero rows
  assert.deepEqual(mapRows('\n'), []);
  assert.equal(mapRows('[{'), null);
  assert.equal(mapRows('{}'), null);
  assert.equal(mapRows(null), null);
  assert.deepEqual(mapRows(JSON.stringify([ROW()])), [{
    id: sid(1), title: 'notes', cwd: FOLDER, model: 'gpt-5.5', messageCount: 2, startedAt: 1795386035692, updatedAt: 1795386044500,
    stats: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0.01, actualCostUsd: null, costStatus: 'estimated', apiCallCount: 1 },
    archived: false,
  }]);
  assert.deepEqual(mapRows(JSON.stringify([ROW({ archived: 1 }), ROW({ archived: 0 })])).map((r) => r.archived), [true, false], 'only ownedSessionsSql reads the column');
  // Hermes's title fallback: title, then the first user message (60 characters + "..."), then the folder name
  const titles = mapRows(JSON.stringify([
    ROW({ title: '  Named  ' }),
    ROW({ preview: 'first line second line' }),
    ROW({ preview: 'x'.repeat(61) }),
    ROW({ preview: '\uAC00'.repeat(60) }),
    ROW({ preview: '\u{1F600}'.repeat(61) }),
    ROW({ cwd: '/Users/u/work/notes/' }),
    ROW({ cwd: null }),
    ROW({ title: '   ', preview: '  hi  ' }),
  ])).map((r) => r.title);
  assert.deepEqual(titles, ['Named', 'first line second line', `${'x'.repeat(60)}...`, '\uAC00'.repeat(60), `${'\u{1F600}'.repeat(60)}...`, 'notes', 'New thread', 'hi']);
  // missing numbers are null; rows without an id are skipped
  const odd = mapRows(JSON.stringify([ROW({ last_active: null, api_call_count: null, cost_status: null }), { id: '' }, 'x', { title: 'no id' }]));
  assert.equal(odd.length, 1);
  assert.equal(odd[0].updatedAt, odd[0].startedAt);
  assert.equal(odd[0].stats.apiCallCount, null);
  assert.equal(odd[0].stats.costStatus, null);
});

test('mapSessionList maps the session/list fallback', () => {
  assert.deepEqual(mapSessionList({ sessions: [{ sessionId: sid(2), cwd: FOLDER, title: 'T', updatedAt: '2026-11-18T11:22:50+00:00' }, { cwd: FOLDER }] }), [
    { id: sid(2), title: 'T', cwd: FOLDER, model: null, messageCount: null, startedAt: null, updatedAt: Date.parse('2026-11-18T11:22:50+00:00'), stats: null, archived: false },
  ]);
  assert.deepEqual(mapSessionList({ sessions: [] }), []);
  assert.deepEqual(mapSessionList(null), []);
});

test('cwd equality: trailing slash, ~, . and ..', () => {
  for (const p of [FOLDER, `${FOLDER}/`, `${FOLDER}//`, '~/work/notes', '~/work/notes/', ' /Users/u/work/./notes ', '/Users/u/work/x/../notes', '/Users/u//work/notes']) {
    assert.equal(normalizeCwd(p, HOME), FOLDER, p);
  }
  assert.equal(normalizeCwd('~', HOME), HOME);
  assert.equal(normalizeCwd('~', '/Users/u/'), HOME);
  assert.notEqual(normalizeCwd('/Users/u/work/notes2', HOME), FOLDER);
  assert.notEqual(normalizeCwd('~other/work/notes', HOME), FOLDER);
  assert.equal(normalizeCwd(null, HOME), '.');
  assert.equal(normalizeCwd('', HOME), '.');
  assert.equal(normalizeCwd('~/work/notes', null), '~/work/notes');
  // rows match the folder through the same rule
  const g = list({ profiles: [{ profile: 'default', rows: [...rowsIn(1, '~/work/notes/'), ...rowsIn(1, `${FOLDER}/`, 2), ...rowsIn(1, '/Users/u/work', 3), ...rowsIn(1, null, 4)] }] }).groups[0];
  assert.deepEqual(g.rows.map((r) => r.sessionId), [sid(2), sid(1)]);
});

test('default is first and always visible; another profile only with rows in the folder; Nod is planned', () => {
  const l = list({ profiles: [
    { profile: 'zeta', rows: rowsIn(1, '/elsewhere') },
    { profile: 'coder', rows: rowsIn(2, '~/work/notes/', 10) },
    { profile: 'default', rows: [] },
    { profile: 'empty', rows: [] },
  ] });
  assert.deepEqual(l.groups.map((g) => [g.profile, g.visible]), [['default', true], ['coder', true], ['empty', false], ['zeta', false]]);
  const def = l.groups[0];
  assert.deepEqual(def.rows, []);
  assert.deepEqual([def.agent, def.loading, def.bridge, def.running, def.collapsed], ['hermes', false, 'off', 0, false]);
  assert.deepEqual(l.groups[1].rows.map((r) => r.key), [`coder/${sid(11)}`, `coder/${sid(10)}`]); // newest first
  assert.deepEqual(l.groups[3].rows, []); // another folder's sessions are not shown
  assert.deepEqual(l.pickable, ['default', 'coder', 'empty', 'zeta']);
  assert.deepEqual(l.planned, [{ agent: 'nod', name: 'Nod', planned: true, disabled: true }]);
  assert.ok(!l.pickable.includes('nod'));
  // default shows with nothing known yet
  assert.deepEqual(list({ profiles: [] }).groups.map((g) => [g.profile, g.visible, g.loading]), [['default', true, true]]);
  assert.deepEqual(list({}).groups.map((g) => g.profile), ['default']);
});

test('bad profile names are refused', () => {
  const l = list({ profiles: ['default', 'Bad', '../x', 'a b', '-x', 'ok-1', { profile: 'UP', rows: rowsIn(1) }, null, 7, 'ok-1'] });
  assert.deepEqual(l.pickable, ['default', 'ok-1']);
  for (const bad of ['Bad', '../x', 'a b', '-x', '', 'a'.repeat(65), null]) assert.equal(isProfileName(bad), false, String(bad));
  assert.equal(isProfileName('default'), true);
  assert.equal(sessionKey('Bad', sid(1)), null);
  assert.equal(sessionKey('default', 'nope'), null);
  assert.equal(sessionKey('default', sid(1)), `default/${sid(1)}`);
  assert.deepEqual(parseKey(`coder/${sid(3)}`), { profile: 'coder', sessionId: sid(3) });
  assert.equal(parseKey(`Coder/${sid(3)}`), null);
  assert.equal(parseKey('coder'), null);
  assert.equal(isSessionId('4733fa10-9a37-48dc-b388-7db72fdbd59b'), true);
  assert.equal(isSessionId('4733FA10-9a37-48dc-b388-7db72fdbd59b'), false);
});

test('Hermes local session IDs round-trip as targets without admitting malformed paths', () => {
  const id = `local-${'ab'.repeat(32)}`;
  assert.deepEqual(parseKey(sessionKey('default', id)), { profile: 'default', sessionId: id });
  for (const bad of [id.slice(0, -1), `${id}0`, `${id}/x`, id.toUpperCase(), `local-${'g'.repeat(64)}`]) {
    assert.equal(sessionKey('default', bad), null);
  }
});

// Hermes local session ids (`local-` and 64 hex digits) and the shared key of the ones Lazuli made.
const LID = (c) => `local-${c.repeat(64)}`;
const OWNED = (...sessions) => ({ v: 1, sessions: sessions.map(([profile, folder, session, at]) => ({ profile, folder, session, at })) });

test('the owned key keeps each local session Lazuli made once, newest first, with its profile and folder', () => {
  assert.equal(isLocalSessionId(LID('a')), true);
  for (const bad of [sid(1), LID('A'), `${LID('a')}0`, LID('a').slice(0, -1), `${LID('a')}/x`, null]) assert.equal(isLocalSessionId(bad), false, String(bad));
  assert.deepEqual(normalizeOwned(null), { v: 1, sessions: [] });
  assert.deepEqual(normalizeOwned({ v: 2, sessions: [] }), { v: 1, sessions: [] });
  const raw = OWNED(
    ['default', `${FOLDER}/`, LID('1'), 10],
    ['default', '/x', LID('1'), 5], // the same session again (older): dropped
    ['coder', FOLDER, LID('1'), 7], // the same id under another profile is another record
    ['default', FOLDER, sid(1), 20], // not a local id: never recorded
    ['Bad', FOLDER, LID('2'), 20], ['default', 'relative', LID('2'), 20], ['default', FOLDER, LID('2'), 'x'],
  );
  assert.deepEqual(normalizeOwned(raw).sessions, [
    { profile: 'default', folder: FOLDER, session: LID('1'), at: 10 },
    { profile: 'coder', folder: FOLDER, session: LID('1'), at: 7 },
  ]);
  const next = addOwned(raw, { profile: 'default', folder: `${FOLDER}/.`, session: LID('3'), at: 30 });
  assert.deepEqual(next.sessions.map((e) => [e.profile, e.folder, e.session]), [['default', FOLDER, LID('3')], ['default', FOLDER, LID('1')], ['coder', FOLDER, LID('1')]]);
  assert.equal(addOwned(next, { profile: 'default', folder: FOLDER, session: LID('3'), at: 40 }), null, 'already held: nothing to write');
  assert.equal(addOwned(next, { profile: 'default', folder: FOLDER, session: sid(3), at: 40 }), null, 'an ACP id needs no record');
  assert.equal(addOwned(next, { profile: 'default', folder: null, session: LID('4'), at: 40 }), null);
  // At most OWNED_MAX, the newest made kept.
  const many = Array.from({ length: OWNED_MAX + 5 }, (_, i) => ['default', FOLDER, `local-${i.toString(16).padStart(64, '0')}`, i]);
  const capped = normalizeOwned(OWNED(...many)).sessions;
  assert.equal(capped.length, OWNED_MAX);
  assert.deepEqual([capped[0].at, capped.at(-1).at], [OWNED_MAX + 4, 5]);
  // The ids of one profile in one folder, as the database query takes them.
  assert.deepEqual(ownedIds(next, `${FOLDER}/`, 'default'), [LID('3'), LID('1')]);
  assert.deepEqual(ownedIds(next, FOLDER, 'coder'), [LID('1')]);
  assert.deepEqual(ownedIds(next, '/elsewhere', 'default'), []);
  assert.deepEqual(ownedIds(next, null, 'default'), []);
});

test('the owned sessions query reads only the given local ids, with 0.17.0 columns', () => {
  assert.equal(ownedSessionsSql([]), null);
  assert.equal(ownedSessionsSql([sid(1), 'x', `${LID('a')}' OR 1=1 --`]), null, 'nothing but local ids is ever inlined');
  const sql = ownedSessionsSql([LID('b'), LID('a'), LID('b'), sid(1)]);
  assert.ok(sql.includes(`s.id IN ('${LID('a')}', '${LID('b')}')`), sql);
  for (const part of ["s.source = 'local'", 's.message_count > 0', 's.archived AS archived', 'NULLIF(s.cwd', 's.estimated_cost_usd', 's.api_call_count']) assert.ok(sql.includes(part), part);
  for (const left of ['created_source', 'hidden', 'last_activity_at', 'LIMIT 1000', 's.archived = 0']) assert.ok(!sql.includes(left), left);
  // The rows map as SESSIONS_SQL's do.
  assert.equal(mapRows(JSON.stringify([ROW({ id: LID('a') })]))[0].id, LID('a'));
});

test('a local session shows only when this profile made it in this folder; ACP rows as before', () => {
  const OWN = LID('1'), OTHER = LID('2'), THERE = LID('3'), CODER = LID('4'), MOVED = LID('5');
  const owned = OWNED(['default', `${FOLDER}/`, OWN, 5], ['default', '/elsewhere', THERE, 4], ['coder', FOLDER, CODER, 3], ['default', FOLDER, MOVED, 2]);
  const stats = { inputTokens: 18, outputTokens: 2903, estimatedCostUsd: 0.1682544, costStatus: 'estimated', apiCallCount: 5 };
  const localRow = (id, cwd = FOLDER, at = 9000) => ({ id, title: `t-${id.slice(6, 8)}`, cwd, model: 'm', messageCount: 10, startedAt: at, updatedAt: at, stats });
  const rows = [...rowsIn(2), localRow(OWN), localRow(OTHER, FOLDER, 9500), localRow(THERE), localRow(CODER), localRow(MOVED, '/elsewhere')];
  const ui = { v: 1, folder: FOLDER, selected: { agent: 'hermes', profile: 'default', session: OWN }, collapsed: [] };
  const profiles = [{ profile: 'default', rows }, { profile: 'coder', rows: [localRow(OWN), localRow(CODER)] }];
  const l = list({ profiles, owned, ui });
  // Another editor's chat in this folder, one made in another folder, one another profile made and one Hermes moved
  // to another folder stay out.
  assert.deepEqual(l.groups[0].rows.map((r) => [r.sessionId, r.selected, r.local]), [[OWN, true, false], [sid(2), false, false], [sid(1), false, false]]);
  assert.deepEqual([l.groups[0].rows[0].stats, l.groups[0].rows[0].messageCount], [stats, 10]);
  assert.deepEqual(l.groups[1].rows.map((r) => r.sessionId), [CODER]);
  assert.equal(pruneUi(ui, l), ui, 'the owned selection survives the list');
  const stray = { ...ui, selected: { ...ui.selected, session: OTHER } };
  assert.equal(pruneUi(stray, list({ profiles, owned, ui: stray })).selected, null, 'an unrelated local selection is cleared');
  // Without the key no local chat shows, and the ACP rows are exactly the legacy list.
  assert.deepEqual(list({ profiles }).groups[0].rows.map((r) => r.sessionId), [sid(2), sid(1)]);
  assert.deepEqual(list({ profiles, owned: { v: 1, sessions: 'x' } }).groups.map((g) => g.visible), [true, false]);
  // session/list (the fallback) lists every local chat of the folder: the same rule applies.
  const listed = mapSessionList({ sessions: [OWN, OTHER].map((sessionId) => ({ sessionId, cwd: FOLDER, updatedAt: '2026-11-25T18:54:00Z' })) });
  assert.deepEqual(list({ profiles: [{ profile: 'default', rows: listed }], owned }).groups[0].rows.map((r) => r.sessionId), [OWN]);
  // Sessions made in this run show before the database has them, local ids among them.
  assert.deepEqual(list({ profiles: [{ profile: 'default', rows: [] }], local: [{ profile: 'default', sessionId: LID('6'), cwd: FOLDER, updatedAt: 1 }] }).groups[0].rows.map((r) => [r.sessionId, r.local]), [[LID('6'), true]]);
});

test('a remembered owned selection stands in for its row until the database lists it or rules it out', () => {
  const OWN = LID('1'), OTHER = LID('2');
  const owned = OWNED(['default', FOLDER, OWN, 5000]);
  const ui = { v: 1, folder: `${FOLDER}/`, selected: { agent: 'hermes', profile: 'default', session: OWN }, collapsed: [] };
  // Held only for a local id that profile made in this folder, from the key as it is stored.
  assert.deepEqual(heldSelection(ui, owned, FOLDER), { profile: 'default', sessionId: OWN, at: 5000 });
  assert.equal(heldSelection(ui, owned, '/elsewhere'), null, 'the key of another folder');
  assert.equal(heldSelection(ui, OWNED(['default', '/elsewhere', OWN, 5000]), FOLDER), null, 'made in another folder');
  assert.equal(heldSelection(ui, OWNED(['coder', FOLDER, OWN, 5000]), FOLDER), null, 'made by another profile');
  assert.equal(heldSelection({ ...ui, selected: { ...ui.selected, session: OTHER } }, owned, FOLDER), null, 'not made here');
  assert.equal(heldSelection({ ...ui, selected: { ...ui.selected, session: sid(1) } }, OWNED(['default', FOLDER, sid(1), 1]), FOLDER), null, 'an ACP id');
  assert.equal(heldSelection(ui, owned, null), null);
  // The service passes it as a session made in this run: it stands in, selected, while the profile's rows lack it
  // (not read yet, none, or no message counted) and once a row lists it the row wins.
  const held = [{ profile: 'default', sessionId: OWN, title: null, updatedAt: 5000, cwd: FOLDER }];
  const at = (rows) => list({ profiles: [{ profile: 'default', rows }], local: held, owned, ui });
  for (const [what, rows] of [['not loaded', null], ['empty', []], ['others only', rowsIn(2)]]) {
    const l = at(rows);
    assert.deepEqual(l.groups[0].rows.find((r) => r.sessionId === OWN)?.local, true, what);
    assert.equal(pruneUi(normalizeUi(ui, FOLDER), l).selected?.session, OWN, what);
  }
  const saved = { id: OWN, title: 'Saved', cwd: FOLDER, model: 'm', messageCount: 2, startedAt: 1, updatedAt: 6000, stats: null, archived: false };
  assert.deepEqual(at([saved]).groups[0].rows.map((r) => [r.sessionId, r.local, r.title]), [[OWN, false, 'Saved']]);
  // Ruled out: archived, or Hermes moved it to another folder. No row then, so the selection is cleared.
  for (const [what, gone] of [['archived', { ...saved, archived: true }], ['moved', { ...saved, cwd: '/elsewhere' }]]) {
    const l = at([gone]);
    assert.deepEqual(l.groups[0].rows, [], what);
    assert.equal(pruneUi(normalizeUi(ui, FOLDER), l).selected, null, what);
  }
  // A record goes as a whole.
  assert.deepEqual(dropOwned(OWNED(['default', FOLDER, OWN, 5], ['coder', FOLDER, OWN, 4]), 'default', OWN).sessions.map((e) => e.profile), ['coder']);
  assert.equal(dropOwned(owned, 'coder', OWN), null);
});

test('local new sessions, running and bridge state, selection and collapse', () => {
  const ui = { v: 1, folder: FOLDER, selected: { agent: 'hermes', profile: 'default', session: sid(2) }, collapsed: ['coder', 'Bad'] };
  const l = list({
    ui,
    profiles: [{ profile: 'default', rows: rowsIn(2) }, { profile: 'coder', rows: [] }, { profile: 'ops', rows: [], error: 'schema' }],
    local: [
      { profile: 'default', sessionId: sid(50), updatedAt: 99000 },
      { profile: 'default', sessionId: sid(1), title: 'dup' },
      { profile: 'coder', sessionId: sid(60), cwd: `${FOLDER}/`, updatedAt: 5 },
      { profile: 'coder', sessionId: sid(61), cwd: '/other' },
      { profile: 'default', sessionId: 'bad' },
    ],
    running: [`default/${sid(1)}`, `coder/${sid(60)}`],
    bridges: { default: { state: 'ready' }, coder: 'starting', ops: 'weird' },
  });
  const [def, coder, ops] = l.groups;
  assert.deepEqual(def.rows.map((r) => [r.sessionId, r.local, r.running, r.selected]), [
    [sid(50), true, false, false], [sid(2), false, false, true], [sid(1), false, true, false],
  ]);
  assert.equal(def.rows[0].title, null);
  assert.equal(def.rows[0].messageCount, 0);
  assert.equal(def.rows[2].title, 's1'); // the database row wins over the local one
  assert.deepEqual([def.running, def.bridge], [1, 'ready']);
  assert.deepEqual(coder.rows.map((r) => r.sessionId), [sid(60)]);
  assert.deepEqual([coder.visible, coder.collapsed, coder.running, coder.bridge], [true, true, 1, 'starting']);
  assert.equal(coder.rows.length, 1); // collapsed keeps its rows for the count and the dot
  assert.deepEqual([ops.visible, ops.error, ops.bridge], [false, 'schema', 'off']);
  // running as a Set or an object works the same
  assert.equal(list({ profiles: [{ profile: 'default', rows: rowsIn(1) }], running: new Set([`default/${sid(1)}`]) }).groups[0].running, 1);
  assert.equal(list({ profiles: [{ profile: 'default', rows: rowsIn(1) }], running: { [`default/${sid(1)}`]: true } }).groups[0].running, 1);
});

test('the shared key is reset for another folder and cleaned', () => {
  const sel = { agent: 'hermes', profile: 'default', session: sid(2) };
  const fresh = { v: 1, folder: FOLDER, selected: null, collapsed: [] };
  assert.deepEqual(normalizeUi({ v: 1, folder: '/elsewhere', selected: sel, collapsed: ['coder'] }, FOLDER), fresh);
  assert.deepEqual(normalizeUi({ v: 1, folder: `${FOLDER}/`, selected: sel, collapsed: ['coder', 'coder', 'X'] }, FOLDER), { v: 1, folder: FOLDER, selected: sel, collapsed: ['coder'] });
  assert.deepEqual(normalizeUi({ v: 2, folder: FOLDER, selected: sel }, FOLDER), fresh);
  assert.deepEqual(normalizeUi(null, FOLDER), fresh);
  assert.equal(normalizeUi({ v: 1, folder: FOLDER, selected: { ...sel, agent: 'nod' } }, FOLDER).selected, null);
  assert.equal(normalizeUi({ v: 1, folder: FOLDER, selected: { ...sel, session: 'x' } }, FOLDER).selected, null);
  assert.equal(normalizeUi({ v: 1, folder: FOLDER, selected: { ...sel, profile: 'Bad' } }, FOLDER).selected, null);
  assert.deepEqual(normalizeUi({ v: 1, folder: FOLDER, selected: sel }, null), { v: 1, folder: null, selected: null, collapsed: [] });
  // buildList applies the same reset
  const other = list({
    profiles: [{ profile: 'default', rows: rowsIn(2) }, { profile: 'coder', rows: rowsIn(1, FOLDER, 9) }],
    ui: { v: 1, folder: '/elsewhere', selected: sel, collapsed: ['coder'] },
  });
  assert.equal(other.groups.flatMap((g) => g.rows).some((r) => r.selected), false);
  assert.equal(other.groups[1].collapsed, false);
  // a selected row that no longer exists is cleared once its group has loaded
  const ui = normalizeUi({ v: 1, folder: FOLDER, selected: { ...sel, session: sid(7) } }, FOLDER);
  assert.equal(pruneUi(ui, list({ profiles: [{ profile: 'default', rows: rowsIn(2) }], ui })).selected, null);
  assert.equal(pruneUi(ui, list({ profiles: [{ profile: 'default', rows: rowsIn(7) }], ui })), ui);
  assert.equal(pruneUi(ui, list({ profiles: ['default'], ui })), ui); // still loading
  assert.equal(pruneUi(ui, list({ profiles: [{ profile: 'default', rows: [], error: 'query' }], ui })), ui); // failed
  const gone = normalizeUi({ v: 1, folder: FOLDER, selected: { ...sel, profile: 'old' } }, FOLDER);
  assert.equal(pruneUi(gone, list({ profiles: [{ profile: 'default', rows: [] }], ui: gone })).selected, null);
  assert.equal(pruneUi(fresh, list({})), fresh);
});

test('150 rows in one group, newest first', () => {
  const rows = rowsIn(150);
  const shuffled = [...rows.filter((_, i) => i % 2), ...rows.filter((_, i) => !(i % 2))];
  const got = list({ profiles: [{ profile: 'default', rows: shuffled }] }).groups[0].rows;
  assert.equal(got.length, 150);
  assert.deepEqual(got.map((r) => r.sessionId), rows.map((r) => r.id).reverse());
  assert.equal(new Set(got.map((r) => r.key)).size, 150);
  assert.ok(got.every((r) => r.local === false && r.running === false && r.selected === false));
});

test('macOS /private paths have a short form; the paths to resolve are each folder once', () => {
  assert.equal(firmlinkShort('/private/tmp/lz-assistant-a'), '/tmp/lz-assistant-a');
  assert.equal(firmlinkShort('/private/var/folders/ab/'), '/var/folders/ab');
  for (const p of ['/private', '/private/', '/privateX/y', '/tmp/x', '/Users/u/private/x', '', 42, null]) assert.equal(firmlinkShort(p), null, String(p));
  const profiles = [{ profile: 'default', rows: [...rowsIn(1, '/private/tmp/lz-a', 1), ...rowsIn(1, '/tmp/lz-a/', 2), ...rowsIn(1, '/tmp/other', 3), ...rowsIn(1, null, 4)] }, { profile: 'work', rows: null }];
  assert.deepEqual(pathsToResolve({ folder: '/tmp/lz-a', home: HOME, profiles, local: [{ cwd: '/tmp/lz-a' }, { cwd: '~/x' }, { cwd: 'rel' }] }), ['/Users/u/x', '/private/tmp/lz-a', '/tmp/lz-a', '/tmp/other']);
  assert.deepEqual(pathsToResolve({}), []);
});

test('a session made in either form of the folder is listed once the paths are resolved (AT-03)', () => {
  const rows = [...rowsIn(1, '/private/tmp/lz-a', 1), ...rowsIn(1, '/tmp/lz-a/', 2), ...rowsIn(1, '/tmp/other', 3), ...rowsIn(1, '/tmp/link-to-a', 4)];
  const real = { '/tmp/lz-a': '/private/tmp/lz-a', '/private/tmp/lz-a': '/private/tmp/lz-a', '/tmp/link-to-a': '/private/tmp/lz-a', '/tmp/other': '/private/tmp/other' };
  const ids = (o) => buildList({ home: HOME, profiles: [{ profile: 'default', rows }], ...o }).groups[0].rows.map((r) => r.sessionId);
  assert.deepEqual(ids({ folder: '/tmp/lz-a' }), [sid(2)], 'without resolving, only the same spelling matches');
  assert.deepEqual(ids({ folder: '/tmp/lz-a', real }), [sid(4), sid(2), sid(1)]);
  assert.deepEqual(ids({ folder: '/private/tmp/lz-a', real }), [sid(4), sid(2), sid(1)], 'a folder kept in the long form');
  assert.deepEqual(ids({ folder: '/tmp/lz-a', real: { ...real, '/tmp/lz-a': '' } }), [sid(2)], 'a folder that does not resolve compares by its path');
  assert.deepEqual(ids({ folder: '/tmp/lz-a', real: { '/tmp/lz-a': '/private/tmp/lz-a' } }), [sid(2)], 'a cwd not resolved yet compares by its path');
  const local = [{ profile: 'default', sessionId: sid(9), cwd: '/private/tmp/lz-a', updatedAt: 9000 }];
  assert.deepEqual(ids({ folder: '/tmp/lz-a', real, local }), [sid(9), sid(4), sid(2), sid(1)]);
});

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: opts.timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
  if (err && typeof err.code !== 'number') return reject(err);
  resolve({ code: err ? err.code : 0, stdout, stderr });
}));

test('folders resolve through symlinks and macOS firmlinks; the short form is kept when it is the same folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lazuli-cwd-'));
  try {
    const real = join(dir, 'real');
    await mkdir(real);
    await symlink(real, join(dir, 'link'));
    const r = await resolvePaths(run, [real, join(dir, 'link'), join(dir, 'missing'), 'relative', `${real}\nx`]);
    assert.deepEqual(Object.keys(r).sort(), [join(dir, 'link'), join(dir, 'missing'), real].sort());
    assert.ok(r[real].endsWith('/real') && r[real].startsWith('/'));
    assert.equal(r[join(dir, 'link')], r[real]);
    assert.equal(r[join(dir, 'missing')], '');
    // A session made through the link is listed in the folder.
    const rows = [...rowsIn(1, join(dir, 'link'), 1), ...rowsIn(1, real, 2)];
    const resolved = await resolvePaths(run, pathsToResolve({ folder: real, home: HOME, profiles: [{ profile: 'default', rows }] }));
    assert.deepEqual(buildList({ folder: real, home: HOME, profiles: [{ profile: 'default', rows }], real: resolved }).groups[0].rows.map((x) => x.sessionId), [sid(2), sid(1)]);
    // The picker's long form is kept short only when the short form is the same folder.
    assert.equal(await shortFolder(run, real), real);
    assert.equal(await shortFolder(run, '/private/lazuli-no-such-folder'), '/private/lazuli-no-such-folder');
    if (platform() === 'darwin' && r[real] === `/private${real}`) assert.equal(await shortFolder(run, `/private${real}`), real);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
