// The Hermes local sessions the Assistant made (`local-<64 hex>`, stored `source='local'` with the cwd column, AT-25):
// sys/assistant.js remembers each one it made with the profile and folder of the bridge that answered
// (`lazuli.assistant.owned`), asks the database for those ids only, and after a reload lists, selects and loads that
// chat with its usage, also while the database does not count its first turn yet (AT-25 on la-c12: a reload mid-way
// through that turn), and without loading it under a turn still waiting for its answer (la-c13: a gateway load lost
// that answer). The real service, list model and shared-key names, started as Herdr starts it (the status copy's
// `start`, then a view's `open`); Herdr, the bridge client and a gateway Hermes are stubs (no Hermes, files or network).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import { KEY } from '../mods/lazuli/sys/state.js';

const host = `data:text/javascript,${encodeURIComponent(`
  export let state;
  export const use = value => { state = value; };
  export const home = () => '/home/test';
  export const appHome = () => '/herdr/test';
  export const readTextFile = async () => state.discovery;
  export const terminals = () => [];
  export const checking = () => false;
  // Persisted as JSON, as Herdr keeps shared values across a reload.
  export const shared = key => (key in state.shared ? JSON.parse(state.shared[key]) : null);
  export const setShared = (key, value) => { state.shared[key] = JSON.stringify(value); };
  export const pickFolder = () => null;
  export const window = () => null;
  export const t = key => key;
  export const settings = () => state.settings;
  export const updateSettings = async fn => { state.settings = fn(state.settings); };
  export const loadSettings = async () => {};
  export const debugLog = () => {};
  export const set = () => {};
  export const blockShown = () => false;
  export const showCenter = () => {};
  export const listProfiles = async () => state.profiles;
  export const listFolderFiles = async () => [];
  export const resolvePaths = async () => ({});
  export const shortFolder = async (run, path) => path;
  // The database as sys/assistant-sessions.js reads it: Hermes's ACP listing, then the local rows among the owned ids
  // that hold a message (an archived one keeps its flag). pauseInventory(profile) holds a read.
  export async function profileSessions(run, home, profile, owned) {
    state.listed.push([state.settings.assistant.folder, profile, owned]);
    if (state.pauseInventory) await state.pauseInventory(profile);
    const table = state.tables[profile] ?? { acp: [], local: [] };
    return { rows: [...table.acp, ...table.local.filter(r => owned.includes(r.id) && r.messageCount > 0)] };
  }
  export class AcpClient {
    constructor({ profile, discovery, ...callbacks }) {
      this.profile = profile;
      this.d = discovery;
      this.pid = discovery.pid;
      this.callbacks = callbacks;
      state.clients.push(this);
    }
    // The bridge's hello (the prompts still running), then the records it replays (K3 \`turns\`).
    async connect(cx, since, { ready }) {
      this.open = true;
      ready({ bridge: this.d, running: state.running ?? [] });
      for (const c of state.replay ?? []) this.callbacks.onRecord({ seq: ++state.seq, c }, cx);
      return { ok: true };
    }
    close() { this.open = false; }
    shutdown() { return { ok: true }; }
    nextId() { return 'r:' + (++state.id); }
    async request(cx, method, params) {
      state.requests.push([this.d.cwd, method, params]);
      if (method === 'session/new') return { ok: true, result: { sessionId: state.newSessionId, models: { currentModelId: 'm' } } };
      if (method === 'session/load') {
        // A Hermes gateway's resume while a prompt of that session waits for its answer: the new snapshot's watermark
        // passes over the turn's message.complete, so that prompt is never answered (AT-25 on la-c13).
        for (const id of state.unanswered?.[params.sessionId] ?? []) state.lost.add(id);
        // The history Hermes replays, then its answer (one without \`models\`: no such session, S9).
        for (const c of state.history?.[params.sessionId] ?? []) this.callbacks.onRecord({ seq: ++state.seq, c }, cx);
        if (state.loadResult) return state.loadResult;
      }
      return { ok: true, result: { models: { currentModelId: 'm' } } };
    }
    async send(cx, msg) {
      state.requests.push([this.d.cwd, msg.method, msg.params]);
      return { ok: true };
    }
  }
  export async function shutdownBridge() { return { ok: true }; }
  export async function hc() { return { code: 0, stdout: '[]', stderr: '' }; }
  export async function exec(command, args) {
    if (args[1] === '--inspect-discovery') return { code: 0, stdout: JSON.stringify({ current: state.discovery, legacy: null }), stderr: '' };
    if (command === '/bin/ps' && args[0] === '-p') return { code: 0, stdout: args[1], stderr: '' };
    if (command === '/bin/sh' && args[2] === 'lazuli-lookup') return { code: 0, stdout: args[3] === 'node' ? '/usr/bin/node' : '/usr/bin/hermes', stderr: '' };
    if (command === '/bin/sh' && args[1] === 'echo "$PPID"') return { code: 0, stdout: '99', stderr: '' };
    if (command === '/bin/ls') return { code: 0, stdout: state.discovered ?? '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    const service = context.parentURL?.includes('/sys/assistant.js?');
    if (specifier === 'herdr' || (service && [
      '../core/i18n.js', './store.js', './bus.js', '../views/panels/common.js', './acp-client.js', './assistant-sessions.js',
    ].includes(specifier))) return { url: ${JSON.stringify(host)}, shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);
const { use } = await import(host);

const cx = {
  sleep: ms => ms === 45000 ? new Promise(() => {}) : Promise.resolve(),
  spawn(fn) { void fn(this); },
};
// The status copy's task: its one-second tick never comes, so only the calls below read the list.
const statusCx = { ...cx, sleep: ms => ms === 1000 ? new Promise(() => {}) : cx.sleep(ms) };
const OWN = `local-${'3d'.repeat(32)}`; // made by this service in /project with default
const OTHER = `local-${'ab'.repeat(32)}`; // another editor's chat in the same folder
const ELSEWHERE = `local-${'cd'.repeat(32)}`; // a local chat in another folder
const ACP = 'aaaaaaaa-0000-4000-8000-000000000001'; // a chat an older Hermes stored as `acp`
const OLD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STATS = { inputTokens: 18, outputTokens: 2903, cacheReadTokens: 67687, cacheWriteTokens: 19317, reasoningTokens: 0,
  estimatedCostUsd: 0.1682544, actualCostUsd: null, costStatus: 'estimated', apiCallCount: 5 };
const row = (id, cwd, at, stats = null) => ({ id, title: `t-${id.slice(0, 8)}`, cwd, model: 'claude-opus-5-5', messageCount: 10,
  startedAt: at, updatedAt: at, stats });
const discovery = folder => JSON.stringify({ version: 1, pid: 100, agentPid: 101, argv: ['/usr/bin/hermes', '-p', 'default', 'acp'],
  port: 3000, token: 'a'.repeat(64), profile: 'default', cwd: folder, herdrPid: 99, startedAt: 1 });

function fixture(folder = '/project') {
  const state = {
    shared: {}, settings: { assistant: { folder } }, discovery: discovery(folder), profiles: ['default', 'coder'],
    listed: [], requests: [], id: 0, seq: 0, clients: [], newSessionId: OWN, lost: new Set(),
    tables: {
      default: { acp: [row(ACP, '/project', 1000)], local: [row(OWN, '/project', 3000, STATS), row(OTHER, '/project', 4000), row(ELSEWHERE, '/elsewhere', 5000)] },
      coder: { acp: [], local: [row(OWN, '/project', 6000)] }, // the same id in another profile's database
    },
  };
  use(state);
  return state;
}
const sharedValue = (state, key) => (key in state.shared ? JSON.parse(state.shared[key]) : null);
let instances = 0;
/** A fresh service module, as after a reload: nothing of the previous instance but the shared keys and the bridge. */
const service = () => import(`../mods/lazuli/sys/assistant.js?owned-${++instances}`);
async function until(check, what) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise(setImmediate);
  }
  assert.fail(what);
}
const loads = state => state.requests.filter(([, method]) => method === 'session/load').map(([cwd, , p]) => [cwd, p.sessionId, p.cwd]);
const rowsOf = s => s.snapshot().list.groups.map(g => [g.profile, g.rows.map(r => [r.sessionId, r.selected])]);
function barrier() {
  let entered, leave;
  const reached = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { leave = resolve; });
  return { reached, leave, pause: () => { entered(); return held; } };
}
const update = (sessionId, sessionUpdate, text) => ({ kind: 'update', sessionId, updateKind: sessionUpdate,
  update: { sessionUpdate, content: { type: 'text', text } } });
/** A record from the bridge after the reload (the newest client's stream). */
const emit = (state, c) => state.clients.at(-1).callbacks.onRecord({ seq: ++state.seq, c }, cx);
/** The shared keys as the service left them before the reload: `session` made here and selected. */
function remembered(state, session, folder = '/project') {
  state.shared[KEY.assistantOwned] = JSON.stringify({ v: 1, sessions: [{ profile: 'default', folder, session, at: 2000 }] });
  state.shared[KEY.assistantUi] = JSON.stringify({ v: 1, folder: '/project', selected: { agent: 'hermes', profile: 'default', session }, collapsed: [] });
}
const selectedOf = state => sharedValue(state, KEY.assistantUi)?.selected?.session ?? null;

test('a local session this service made is listed, selected and loaded again after a reload, with its usage', async () => {
  const state = fixture();
  const first = await service();
  assert.deepEqual(await first.open(cx), { ok: true });
  assert.deepEqual(state.listed, [['/project', 'default', []], ['/project', 'coder', []]], 'nothing owned yet: no local id is asked');
  assert.deepEqual(rowsOf(first), [['default', [[ACP, false]]], ['coder', []]], 'neither another editor\'s local chat nor one elsewhere shows');

  assert.deepEqual(await first.newSession(cx), { ok: true, key: `default/${OWN}` });
  const owned = sharedValue(state, KEY.assistantOwned);
  assert.deepEqual(owned.sessions.map(({ at, ...e }) => e), [{ profile: 'default', folder: '/project', session: OWN }]);
  assert.equal(typeof owned.sessions[0].at, 'number');
  assert.deepEqual(sharedValue(state, KEY.assistantUi).selected, { agent: 'hermes', profile: 'default', session: OWN });

  // Reload mid-life: a new instance with the same shared keys and bridge; Hermes's database holds the chat's turns now.
  state.listed = [];
  state.requests = [];
  const second = await service();
  assert.deepEqual(await second.open(cx), { ok: true });
  assert.deepEqual(state.listed, [['/project', 'default', [OWN]], ['/project', 'coder', []]], 'only the owned id, only for its profile');
  const key = `default/${OWN}`;
  await until(() => second.session(key)?.loaded, 'the remembered chat loads');
  assert.deepEqual(loads(state), [['/project', OWN, '/project']]);
  assert.deepEqual(rowsOf(second), [['default', [[OWN, true], [ACP, false]]], ['coder', []]]);
  assert.equal(second.snapshot().list.groups[0].rows[0].local, false, 'the database row, not a stand-in');
  assert.deepEqual(second.session(key).usage.stats, STATS, 'its usage and cost come from the database row');
  assert.deepEqual(sharedValue(state, KEY.assistantUi).selected, { agent: 'hermes', profile: 'default', session: OWN }, 'the selection survived the list');
});

test('the record stays with its folder: another folder neither asks for nor shows it, and returning restores it', async () => {
  const state = fixture('/other');
  state.shared[KEY.assistantOwned] = JSON.stringify({ v: 1, sessions: [{ profile: 'default', folder: '/project', session: OWN, at: 1 }] });
  state.shared[KEY.assistantUi] = JSON.stringify({ v: 1, folder: '/project', selected: { agent: 'hermes', profile: 'default', session: OWN }, collapsed: [] });
  state.tables.default.acp = [row(ACP, '/other', 1000)];
  state.tables.default.local.push(row(OWN, '/other', 7000)); // even if its row claimed this folder
  const other = await service();
  assert.deepEqual(await other.open(cx), { ok: true });
  assert.deepEqual(state.listed, [['/other', 'default', []], ['/other', 'coder', []]]);
  assert.deepEqual(rowsOf(other), [['default', [[ACP, false]]], ['coder', []]]);
  await new Promise(setImmediate);
  assert.deepEqual(loads(state), [], 'nothing selected in this folder');
  assert.equal(sharedValue(state, KEY.assistantOwned).sessions.length, 1, 'the record is kept');

  state.tables.default.local.pop();
  state.tables.default.acp = [row(ACP, '/project', 1000)];
  state.settings = { assistant: { folder: '/project' } };
  state.discovery = discovery('/project');
  state.listed = [];
  const back = await service();
  assert.deepEqual(await back.open(cx), { ok: true });
  assert.deepEqual(state.listed, [['/project', 'default', [OWN]], ['/project', 'coder', []]]);
  await until(() => back.session(`default/${OWN}`)?.loaded, 'the chat loads in its folder again');
  assert.deepEqual(loads(state), [['/project', OWN, '/project']]);
  assert.deepEqual(rowsOf(back), [['default', [[OWN, true], [ACP, false]]], ['coder', []]]);
});

test('an ACP session id (older Hermes) is not recorded; Hermes lists it itself', async () => {
  const state = fixture();
  state.newSessionId = OLD;
  const s = await service();
  assert.deepEqual(await s.open(cx), { ok: true });
  assert.deepEqual(await s.newSession(cx), { ok: true, key: `default/${OLD}` });
  assert.equal(sharedValue(state, KEY.assistantOwned), null);
  assert.deepEqual(rowsOf(s), [['default', [[OLD, true], [ACP, false]]], ['coder', []]]);
});

test('reload mid-way through the first turn: the remembered chat stays selected while the database lags, and loads by itself', async () => {
  const state = fixture();
  const key = `default/${OWN}`;
  remembered(state, OWN);
  // Hermes has not counted the turn's messages yet (AT-25, la-c12): its row lists nothing; the turn is still running on
  // the bridge, which the reloaded service finds again.
  state.tables.default.local = [{ ...row(OWN, '/project', 3000, STATS), messageCount: 0 }, row(OTHER, '/project', 4000)];
  state.discovered = 'default.json\n';
  state.running = [{ id: 'old:2', sessionId: OWN, at: 1, seq: 1, prompt: [{ type: 'text', text: 'Write a paper boat story' }] }];
  state.replay = [update(OWN, 'agent_message_chunk', 'Once a paper boat')];
  state.unanswered = { [OWN]: ['old:2'] };
  const inventory = barrier();
  state.pauseInventory = inventory.pause;

  const s = await service();
  s.start(statusCx); // the status copy: reconnects to the running bridge, then reads the list
  await inventory.reached;
  assert.deepEqual(state.listed, [['/project', 'default', [OWN]]]);
  assert.equal(s.snapshot().bridges.default.state, 'ready');
  const opening = s.open(cx); // a view opens while the inventory is still out
  inventory.leave();
  assert.deepEqual(await opening, { ok: true });
  await until(() => s.session(key)?.loaded, 'the remembered chat shows without a selection call');
  assert.equal(selectedOf(state), OWN, 'the selection outlived an inventory without its row');
  assert.deepEqual(loads(state), [], 'its load waits for the running turn\'s answer (la-c13)');
  assert.deepEqual(rowsOf(s), [['default', [[OWN, true], [ACP, false]]], ['coder', []]], 'it stands in, selected; the other chat stays out');
  assert.equal(s.snapshot().list.groups[0].rows[0].local, true);

  // The turn goes on and ends; Hermes then counts its messages and cost, the row replaces the stand-in, and the chat
  // loads once.
  state.tables.default.local[0] = row(OWN, '/project', 3000, STATS);
  state.history = { [OWN]: pair(OWN, 'Write a paper boat story', 'Once a paper boat The paper boat made it home.') };
  emit(state, update(OWN, 'agent_message_chunk', ' The paper boat made it home.'));
  assert.equal(finishTurn(state, 'old:2'), true);
  await until(() => s.snapshot().list.groups[0].rows[0]?.local === false && historyLoaded(s.session(key)), 'the database row replaces the stand-in');
  const chat = s.session(key);
  assert.deepEqual(chat.items.filter(it => it.type === 'user' || it.type === 'assistant').map(it => [it.type, it.text]), [
    ['user', 'Write a paper boat story'], ['assistant', 'Once a paper boat The paper boat made it home.'],
  ]);
  assert.equal(chat.loaded && !chat.stale && Object.keys(chat.inflight).length === 0, true);
  assert.deepEqual(chat.usage.stats, STATS, 'its usage and cost from the database row');
  assert.equal(selectedOf(state), OWN);
  assert.deepEqual(loads(state), [['/project', OWN, '/project']], 'loaded once');
});

test('a newer selection made while the inventory is out wins over the remembered one', async () => {
  const state = fixture();
  remembered(state, OWN);
  state.discovered = 'default.json\n';
  const coder = barrier();
  state.pauseInventory = profile => (profile === 'coder' ? coder.pause() : undefined);
  const s = await service();
  s.start(statusCx);
  await coder.reached; // default is listed; coder is still out
  const opening = s.open(cx);
  await until(() => s.snapshot().gate === 'ok', 'the gates pass');
  assert.deepEqual(await s.select(cx, `default/${ACP}`), { ok: true });
  coder.leave();
  assert.deepEqual(await opening, { ok: true });
  await new Promise(setImmediate);
  assert.equal(selectedOf(state), ACP);
  assert.deepEqual(loads(state), [['/project', ACP, '/project']], 'the remembered chat is not loaded over it');
  assert.deepEqual(rowsOf(s)[0], ['default', [[OWN, false], [ACP, true]]]);
});

test('a remembered owned chat Hermes has no session for is cleared and forgotten, not kept', async () => {
  const state = fixture();
  remembered(state, OWN);
  state.tables.default.local = [row(OTHER, '/project', 4000)]; // no row for it
  state.loadResult = { ok: true, result: {} };
  const s = await service();
  assert.deepEqual(await s.open(cx), { ok: true });
  await until(() => selectedOf(state) === null, 'the selection is cleared');
  assert.deepEqual(loads(state), [['/project', OWN, '/project']]);
  assert.deepEqual(sharedValue(state, KEY.assistantOwned).sessions, []);
  assert.deepEqual(rowsOf(s), [['default', [[ACP, false]]], ['coder', []]]);
  await s.refreshList(cx);
  assert.deepEqual(loads(state).length, 1, 'no load again');
});

test('a remembered chat another folder owns, or one Hermes archived or moved, is not held', async () => {
  for (const [what, prepare] of [
    ['owned in another folder', state => remembered(state, OWN, '/elsewhere')],
    ['archived', state => { remembered(state, OWN); state.tables.default.local[0] = { ...state.tables.default.local[0], archived: true }; }],
    ['moved to another folder', state => { remembered(state, OWN); state.tables.default.local[0] = { ...state.tables.default.local[0], cwd: '/elsewhere' }; }],
  ]) {
    const state = fixture();
    prepare(state);
    const s = await service();
    assert.deepEqual(await s.open(cx), { ok: true }, what);
    await new Promise(setImmediate);
    assert.equal(selectedOf(state), null, what);
    assert.deepEqual(loads(state), [], what);
    assert.deepEqual(rowsOf(s), [['default', [[ACP, false]]], ['coder', []]], what);
  }
});

// A reload while Hermes answers (AT-25 on la-c13): the bridge still holds the prompt as unanswered and replays what it
// streamed; Hermes's answer is the only proof the turn ended.
const PROMPT = 'Write a toy train story';
const ANSWER = 'Once a toy train left. The toy train reached the station.';
function midTurn(state, session, id, chunks, { gateway = true } = {}) {
  state.discovered = 'default.json\n';
  state.running = [{ id, sessionId: session, at: 1, seq: 1, prompt: [{ type: 'text', text: PROMPT }] }];
  state.replay = chunks.map(text => update(session, 'agent_message_chunk', text));
  state.unanswered = gateway ? { [session]: [id] } : {};
}
/** Hermes ends prompt `id`: its answer reaches the bridge unless a load lost it. */
function finishTurn(state, id, stopReason = 'end_turn') {
  if (state.lost.has(id)) return false;
  for (const ids of Object.values(state.unanswered ?? {})) ids.splice(ids.indexOf(id) >>> 0, ids.includes(id) ? 1 : 0);
  emit(state, { kind: 'result', id, result: { stopReason } });
  return true;
}
const said = chat => chat.items.filter(it => it.type === 'user' || it.type === 'assistant').map(it => [it.type, it.text]);
const pair = (session, prompt, answer) => [update(session, 'user_message_chunk', prompt), update(session, 'agent_message_chunk', answer)];
const historyLoaded = chat => chat?.loaded && chat.models?.currentModelId === 'm';

async function reloadMidTurn(state, session) {
  const s = await service();
  s.start(statusCx);
  assert.deepEqual(await s.open(cx), { ok: true });
  await until(() => s.session(`default/${session}`)?.loaded, 'the running turn shows');
  await new Promise(setImmediate);
  return s;
}

test('reload while a gateway turn runs: no load under it, the turn streams once, then one load and one transcript, idle with its cost', async () => {
  const state = fixture();
  const key = `default/${OWN}`;
  remembered(state, OWN);
  state.tables.default.local = [{ ...row(OWN, '/project', 3000, STATS), messageCount: 0 }];
  midTurn(state, OWN, 'old:3', ['Once ', 'a toy train ']);
  const s = await reloadMidTurn(state, OWN);
  const chat = () => s.session(key);
  assert.deepEqual(loads(state), [], 'no session/load while its answer is still out');
  assert.deepEqual(said(chat()), [['user', PROMPT], ['assistant', 'Once a toy train ']]);
  assert.deepEqual(Object.keys(chat().inflight), ['old:3']);
  assert.equal(chat().items.at(-1).streaming, true);
  assert.equal(selectedOf(state), OWN);
  emit(state, update(OWN, 'agent_message_chunk', 'left. The toy train reached the station.'));
  assert.deepEqual(said(chat()), [['user', PROMPT], ['assistant', ANSWER]], 'it streams into the same reply');

  // Hermes ends the turn; its database then holds the pair, which the load replays.
  state.tables.default.local = [row(OWN, '/project', 3000, STATS)];
  state.history = { [OWN]: pair(OWN, PROMPT, ANSWER) };
  assert.equal(finishTurn(state, 'old:3'), true);
  await until(() => historyLoaded(chat()) && s.snapshot().list.groups[0].rows[0]?.local === false, 'one load once the answer came');
  assert.deepEqual(loads(state), [['/project', OWN, '/project']]);
  assert.deepEqual(said(chat()), [['user', PROMPT], ['assistant', ANSWER]], 'one transcript');
  assert.deepEqual(chat().inflight, {});
  assert.equal(chat().items.some(it => it.streaming), false);
  assert.deepEqual(chat().usage.stats, STATS);
  assert.equal(selectedOf(state), OWN);
  assert.deepEqual([...state.lost], [], 'no answer was lost');
});

test('without its answer the turn is not taken for ended: a select and a Stop neither load nor idle it', async () => {
  const state = fixture();
  const key = `default/${OWN}`;
  remembered(state, OWN);
  midTurn(state, OWN, 'old:3', ['Once ']);
  const s = await reloadMidTurn(state, OWN);
  assert.deepEqual(await s.select(cx, key), { ok: true });
  assert.deepEqual(await s.stopTurn(cx, key), { ok: true });
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.deepEqual(state.requests.filter(([, method]) => method === 'session/cancel').map(([, , p]) => p.sessionId), [OWN]);
  assert.deepEqual(loads(state), []);
  assert.deepEqual(Object.keys(s.session(key).inflight), ['old:3'], 'still running: Hermes has not answered');
  assert.deepEqual(said(s.session(key)), [['user', PROMPT], ['assistant', 'Once ']]);
  // The answer to that Stop ends it; then it loads once.
  state.history = { [OWN]: pair(OWN, PROMPT, 'Once ') };
  assert.equal(finishTurn(state, 'old:3', 'cancelled'), true);
  await until(() => historyLoaded(s.session(key)), 'loaded after the answer');
  assert.deepEqual(loads(state), [['/project', OWN, '/project']]);
  assert.deepEqual(s.session(key).inflight, {});
  assert.deepEqual(said(s.session(key)), [['user', PROMPT], ['assistant', 'Once ']]);
});

test('a repeated identical prompt and answer stay two turns', async () => {
  const state = fixture();
  const key = `default/${OWN}`;
  remembered(state, OWN);
  state.history = { [OWN]: pair(OWN, PROMPT, ANSWER) }; // the same ask, answered the same way, before
  midTurn(state, OWN, 'old:5', [ANSWER]);
  const s = await reloadMidTurn(state, OWN);
  assert.deepEqual(said(s.session(key)), [['user', PROMPT], ['assistant', ANSWER]], 'the running one, live');
  state.history = { [OWN]: [...pair(OWN, PROMPT, ANSWER), ...pair(OWN, PROMPT, ANSWER)] };
  assert.equal(finishTurn(state, 'old:5'), true);
  await until(() => historyLoaded(s.session(key)), 'loaded after the answer');
  assert.deepEqual(said(s.session(key)), [['user', PROMPT], ['assistant', ANSWER], ['user', PROMPT], ['assistant', ANSWER]]);
  assert.deepEqual(loads(state).length, 1);
});

test('an ACP session (in-process Hermes) still loads mid-turn: its history, then the running turn once', async () => {
  const state = fixture();
  const key = `default/${OLD}`;
  remembered(state, OLD);
  state.tables.default.acp.push(row(OLD, '/project', 1500));
  midTurn(state, OLD, 'old:4', ['Partial '], { gateway: false });
  state.history = { [OLD]: pair(OLD, 'Earlier?', 'Earlier.') }; // it saves a turn when the turn ends
  const s = await reloadMidTurn(state, OLD);
  await until(() => historyLoaded(s.session(key)), 'loaded during the turn');
  assert.deepEqual(loads(state), [['/project', OLD, '/project']]);
  assert.deepEqual(said(s.session(key)), [['user', 'Earlier?'], ['assistant', 'Earlier.'], ['user', PROMPT], ['assistant', 'Partial ']]);
  assert.deepEqual(Object.keys(s.session(key).inflight), ['old:4']);
  assert.equal(finishTurn(state, 'old:4'), true);
  await until(() => !Object.keys(s.session(key).inflight).length, 'idle');
  assert.deepEqual(loads(state).length, 1);
  assert.deepEqual(said(s.session(key)), [['user', 'Earlier?'], ['assistant', 'Earlier.'], ['user', PROMPT], ['assistant', 'Partial ']]);
});

// K5 rule 6 after a history-rewriting command: `/compact` reloads the chat, then the queue head goes (once), unless
// the queue is paused.
const promptTexts = state => state.requests.filter(([, method]) => method === 'session/prompt').map(([, , p]) => p.prompt.map(b => b.text).join(''));
for (const [kind, session] of [['an ACP chat', OLD], ['a gateway chat', OWN]]) {
  for (const paused of [false, true]) {
    test(`after /compact in ${kind} the chat reloads, then ${paused ? 'a paused queue stays unsent' : 'the queued chip goes once'}`, async () => {
      const state = fixture();
      state.newSessionId = session;
      const s = await service();
      assert.deepEqual(await s.open(cx), { ok: true });
      const { key } = await s.newSession(cx);
      assert.deepEqual(await s.send(cx, key, { text: '/compact' }), { ok: true });
      const [command] = Object.keys(s.session(key).inflight);
      assert.deepEqual(await s.queue(cx, key, 'after compact'), { ok: true });
      assert.equal(s.session(key).queue.length, 1, 'queued while the command runs');
      if (paused) assert.deepEqual(await s.stopTurn(cx, key), { ok: true });
      state.history = { [session]: pair(session, 'Write a toy train story', 'Compacted.') };
      emit(state, { kind: 'result', id: command, result: { stopReason: paused ? 'cancelled' : 'end_turn' } });
      await until(() => loads(state).length === 1 && historyLoaded(s.session(key)), 'the chat reloads after the command');
      for (let i = 0; i < 20; i++) await new Promise(setImmediate);
      const chat = s.session(key);
      if (paused) {
        assert.deepEqual(promptTexts(state), ['/compact']);
        assert.deepEqual([chat.queue.map(c => c.text), chat.queuePaused], [['after compact'], true]);
        assert.deepEqual(chat.inflight, {});
      } else {
        assert.deepEqual(promptTexts(state), ['/compact', 'after compact'], 'the chip, once');
        const at = method => state.requests.findIndex(([, m, p]) => m === method && (method !== 'session/prompt' || p.prompt[0].text === 'after compact'));
        assert.ok(at('session/load') < at('session/prompt'), 'after the reload');
        assert.deepEqual(chat.queue, []);
        assert.deepEqual(said(chat), [['user', 'Write a toy train story'], ['assistant', 'Compacted.'], ['user', 'after compact']]);
        assert.equal(Object.keys(chat.inflight).length, 1, 'the chip runs as the next turn');
      }
      assert.equal(loads(state).length, 1, 'one reload');
    });
  }
}
