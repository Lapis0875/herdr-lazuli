import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Run the real manager and wire parser without any Herdr, process-table, file, or signal I/O.
const host = `data:text/javascript,${encodeURIComponent(`
  export let state;
  export const use = value => { state = value; };
  export const home = () => '/home/test';
  export const appHome = () => '/herdr/test';
  export const readTextFile = async () => state.discovery;
  export const terminals = () => state.live;
  export default { connect: (...args) => state.connect(...args) };
  export const checking = () => false;
  export const shared = () => null;
  export const setShared = () => {};
  export const pickFolder = () => null;
  export const window = () => null;
  export const t = key => key;
  export const settings = () => state.settings;
  export const updateSettings = async fn => { state.settings = fn(state.settings); };
  export const loadSettings = async () => {};
  export const profileSessions = async () => ({ rows: [] });
  export const shortFolder = async (run, path) => path;
  export const debugLog = () => {};
  export const set = () => {};
  export const KEY = { assistantUi: 'assistant' };
  export const blockShown = () => false;
  export const showCenter = () => {};
  export const listProfiles = async () => [];
  export const listFolderFiles = async () => [];
  export const resolvePaths = async () => ({});
  export class AcpClient {
    constructor({ profile, discovery, ...callbacks }) {
      this.profile = profile;
      this.d = discovery;
      this.pid = discovery.pid;
      this.seq = 1;
      this.callbacks = callbacks;
    }
    async connect(cx, since, { ready }) {
      state.steps.push(['attach', this.d.token]);
      if (this.d.token === state.oldToken) return { error: 'bridge-timeout' };
      state.clients?.push(this);
      if (state.pauseHello && since !== null) await state.pauseHello();
      this.open = true;
      ready({ bridge: { ...this.d, ...state.helloOverride }, running: state.helloRunning ?? (this.d.token === state.lateToken && since !== null
        ? [{ id: 'old:1', sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: [] }] : []) });
      return { ok: true };
    }
    close() { this.open = false; }
    shutdown(cx) { return shutdownBridge(cx, this.d); }
    nextId() { return this.d.token.slice(0, 1) + ':' + (++state.id); }
    async request(cx, method, params) {
      state.requests.push([this.d.cwd, this.d.token, method, params]);
      if (method === 'session/load' && state.loadReplies?.length) return state.loadReplies.shift()();
      return { ok: true, result: { sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', models: {} } };
    }
    async send(cx, msg) {
      state.requests.push([this.d.cwd, this.d.token, msg.method, msg.params]);
      return { ok: true };
    }
  }
  export async function shutdownBridge(cx, d) {
    state.steps.push(['shutdown', d.token]);
    state.shutdownRequested = true;
    if (state.unlinkEarly) state.discovery = null;
    return state.shutdownReply;
  }
  export async function hc(args) {
    state.hc.push(args);
    if (args[0] === 'ls') {
      if (state.pauseReap) { const pause = state.pauseReap; state.pauseReap = null; await pause(); }
      if (state.pauseListing) await state.pauseListing();
      if (state.listingReplies?.length) return state.listingReplies.shift();
      return { code: 0, stdout: JSON.stringify([...state.live.filter(t => t.labels?.[args.at(-1).split('=')[0]]), ...state.finished]) };
    }
    if (args[0] === 'run') {
      const address = state.addresses?.shift() ?? state.address ?? state.live[0].address;
      if (state.pauseRun) { const pause = state.pauseRun; state.pauseRun = null; await pause(); }
      if (state.replaceOnExit) return { code: 1, stderr: 'discovery changed before reservation', stdout: '' };
      if (state.replacement) {
        state.steps.push(['launch']);
        state.discovery = JSON.stringify({ ...state.replacement, cwd: args[args.indexOf('--cwd') + 1],
          startedAt: Date.now(), launchId: args[args.indexOf('--launch-id') + 1] });
      }
      return { code: 0, stdout: JSON.stringify({ address }) };
    }
    return { code: 0, stdout: '' };
  }
  export async function exec(command, args) {
    state.exec.push([command, args]);
    if (args[1] === '--inspect-discovery') {
      if (state.readError === 'throw') throw new Error('EACCES');
      if (state.readError) return { code: 1, stdout: '', stderr: state.readError };
      return { code: 0, stdout: JSON.stringify({ current: state.discovery ?? null, legacy: state.legacy ?? null }) };
    }
    if (command === '/bin/ps' && args[0] === '-p') {
      let status = state.commands.has(Number(args[1])) ? 'present' : 'gone';
      if (state.shutdownRequested && Number(args[1]) === state.oldPid) {
        status = state.exitState ?? status;
        if (state.replaceOnExit) state.discovery = state.replaceOnExit;
      }
      state.steps?.push(['probe', status]);
      if (status === 'present') return { code: 0, stdout: args[1], stderr: '' };
      return { code: 1, stdout: '', stderr: status === 'unknown' ? 'lookup failed' : '' };
    }
    if (command === '/bin/ls') return { code: 0, stdout: state.discovered ?? '' };
    if (command === '/bin/ps') return { code: 0, stdout: state.commands.get(Number(args.at(-1))) ?? '' };
    if (command === '/bin/kill' && args[0] === '-0') return { code: state.commands.has(Number(args[1])) ? 0 : 1 };
    if (command === '/bin/sh' && args[2] === 'lazuli-lookup') {
      return { code: 0, stdout: args[3] === 'node' ? '/usr/bin/node' : '/usr/bin/hermes' };
    }
    if (command === '/bin/sh' && args[1] === 'echo "$PPID"') return { code: 0, stdout: '99' };
    if (command === '/bin/rm') throw new Error('The manager must never mutate discovery');
    return { code: 0, stdout: '' };
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    const service = context.parentURL?.includes('/sys/assistant.js?');
    if (specifier === 'net' && context.parentURL?.includes('/sys/acp-client.js?')) {
      return { url: ${JSON.stringify(host)}, shortCircuit: true };
    }
    if (specifier === 'herdr' || (service && [
      '../core/i18n.js', './store.js', './state.js', './bus.js', '../views/panels/common.js',
      './acp-client.js', './assistant-sessions.js',
    ].includes(specifier))) return { url: ${JSON.stringify(host)}, shortCircuit: true };
    return next(specifier, context);
  }
`)}`, import.meta.url);
const { use } = await import(host);
const bridge = await import('../mods/lazuli/sys/assistant-bridge.js');

const profile = 'dev';
const argv = ['/usr/bin/hermes', '-p', profile, 'acp'];
const ready = {
  version: 1, pid: 100, agentPid: 101, argv, port: 3000, token: 'a'.repeat(64), profile,
  cwd: '/project', herdrPid: 99,
};

function fixture() {
  const host = {
    live: [{ state: 'live', address: 't-live', pid: 101, labels: { 'lazuli.assistant.v2': profile } }],
    finished: [], settings: { assistant: { folder: '/project' } },
    commands: new Map(), hc: [], exec: [],
  };
  use(host);
  return host;
}

test('retirement does not inspect or signal a different bridge with the real launch command', async () => {
  const host = fixture();
  host.replacement = { ...ready, pid: 101, agentPid: 102 };
  host.steps = [];
  const launched = await bridge.launch(cx, {
    profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv, snapshot: await bridge.readDiscovery(profile), valid: () => true,
  });
  assert.equal(launched.address, 't-live');
  const launch = host.hc.find(args => args[0] === 'run');
  const command = launch.slice(launch.indexOf('--') + 1);
  assert.equal(command[1], bridge.bridgeScript());
  assert.deepEqual(command.slice(-argv.length - 2), ['--agent', '--', ...argv]);
  host.commands.set(101, command.join(' '));
  host.hc.length = host.exec.length = 0;

  host.discovery = JSON.stringify({ ...ready, startedAt: 1 });
  const saved = host.discovery;
  await bridge.reap([profile]);
  assert.ok(host.hc.every(([op]) => op === 'ls'));
  assert.deepEqual(host.exec, []);
  assert.equal(host.discovery, saved);
});

test('a legacy record and a recycled bridge PID do not authorize terminal kill', async () => {
  const host = fixture();
  host.legacy = JSON.stringify({ ...ready, pid: 101, agentPid: 102, argv: undefined, startedAt: 1 });
  host.commands.set(101, '/different/bridge');
  const discovery = await bridge.readDiscovery(profile);
  assert.equal(discovery.state, 'ready');
  assert.equal(discovery.argv, null);

  const blocked = await bridge.launch(cx, { profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv, snapshot: discovery, valid: () => true });
  assert.equal(blocked.error, 'bridge-timeout');
  assert.deepEqual(host.hc, []);

  host.hc.length = host.exec.length = 0;
  assert.equal(await bridge.awaitExit({ sleep: async () => {} }, profile, discovery.pid), false);
  assert.deepEqual(host.hc, []);
  assert.ok(host.exec.length > 0);
  for (const call of host.exec) assert.deepEqual(call, ['/bin/ps', ['-p', '101', '-o', 'pid=']]);
});

const cx = {
  sleep: ms => ms === 45000 ? new Promise(() => {}) : Promise.resolve(),
  spawn(fn) { void fn(this); },
};
const defaultReady = { ...ready, profile: 'default', argv: ['/usr/bin/hermes', '-p', 'default', 'acp'] };
const defaultFixture = () => {
  const host = fixture();
  host.live = [{ state: 'live', address: 't-new', pid: 102, labels: { 'lazuli.assistant.v2': 'default' } }];
  host.oldPid = defaultReady.pid;
  host.oldToken = defaultReady.token;
  host.commands.set(host.oldPid, 'bridge');
  host.discovery = JSON.stringify({ ...defaultReady, startedAt: 1 });
  host.replacement = { ...defaultReady, pid: 102, agentPid: 103, token: 'b'.repeat(64) };
  host.steps = [];
  host.clients = [];
  host.requests = [];
  host.id = 0;
  return host;
};

test('a matching bridge without hello exits before a replacement launch', async () => {
  const host = defaultFixture();
  host.shutdownReply = { ok: true };
  host.exitState = 'gone';
  const service = await import('../mods/lazuli/sys/assistant.js?confirmed-exit');
  assert.deepEqual(await service.open(cx), { ok: true });
  assert.deepEqual(host.steps, [
    ['probe', 'present'], ['attach', host.oldToken], ['shutdown', host.oldToken], ['probe', 'gone'],
    ['launch'], ['attach', host.replacement.token],
  ]);
});

for (const [scenario, shutdownReply, exitState, unlinkEarly] of [
  ['acknowledged without exit', { ok: true }, 'present', false],
  ['failed probe and lost acknowledgement', { error: 'disconnected' }, 'unknown', false],
  ['legacy early unlink', { error: 'disconnected' }, 'present', true],
]) {
  test(`uncertain replacement does not retire or launch: ${scenario}`, async () => {
    const host = defaultFixture();
    Object.assign(host, { shutdownReply, exitState, unlinkEarly });
    const service = await import(`../mods/lazuli/sys/assistant.js?${encodeURIComponent(scenario)}`);
    assert.equal((await service.open(cx)).error, 'bridge-timeout');
    assert.deepEqual(host.steps.slice(0, 4), [
      ['probe', 'present'], ['attach', host.oldToken], ['shutdown', host.oldToken], ['probe', exitState],
    ]);
    assert.ok(host.steps.slice(4).every(([op]) => op === 'probe'));
    if (!unlinkEarly) assert.equal(JSON.parse(host.discovery).token, host.oldToken);

    host.steps.length = 0;
    assert.equal((await service.retryBridge(cx, 'default')).error, 'bridge-timeout');
    assert.deepEqual(host.steps.filter(([op]) => op !== 'probe'), [['attach', host.oldToken], ['shutdown', host.oldToken]]);
  });
}

test('retirement cannot replace a newer discovery with the same numeric PID', async () => {
  const host = defaultFixture();
  host.shutdownReply = { ok: true };
  host.exitState = 'gone';
  host.replaceOnExit = JSON.stringify({ ...defaultReady, token: 'c'.repeat(64), startedAt: 2 });
  const service = await import('../mods/lazuli/sys/assistant.js?newer-discovery');
  assert.equal((await service.open(cx)).error, 'bridge-launch-failed');
  assert.ok(host.exec.every(([command]) => command !== '/bin/rm'));
  assert.equal(host.discovery, host.replaceOnExit);
});

for (const readError of ['throw', 'EACCES']) {
  test(`an indeterminate discovery read never authorizes launch: ${readError}`, async () => {
    const host = defaultFixture();
    host.readError = readError;
    const service = await import(`../mods/lazuli/sys/assistant.js?unreadable-${readError}`);
    assert.equal((await service.open(cx)).error, 'disconnected');
    assert.equal((await bridge.readDiscovery('default')).state, 'unreadable');
    assert.deepEqual(host.hc, []);
  });
}

function barrier() {
  let entered, leave;
  const reached = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { leave = resolve; });
  return { reached, leave, pause: () => { entered(); return held; } };
}

async function untilFolder(service, folder) {
  for (let i = 0; i < 100; i++) {
    if (service.snapshot().folder === folder) return;
    await Promise.resolve();
  }
  assert.fail(`folder did not change to ${folder}`);
}

for (const phase of ['Reap', 'Run']) for (const returnToA of [false, true]) {
  test(`a ${phase.toLowerCase()} in flight cannot swallow the new open (${returnToA ? 'A→B→A' : 'A→B'})`, async () => {
    const host = defaultFixture();
    host.discovery = JSON.stringify({ version: 1, pid: 100, error: { code: 'init-failed' } });
    host.live.unshift({ state: 'live', address: 't-unrelated', pid: 104, labels: { 'lazuli.assistant.v2': 'default' } });
    host.addresses = phase === 'Run' ? ['t-stale', 't-new'] : ['t-new'];
    const blocked = barrier();
    host[`pause${phase}`] = blocked.pause;
    const service = await import(`../mods/lazuli/sys/assistant.js?generation-${phase}-${returnToA}`);
    const opening = service.open(cx);
    await blocked.reached;
    const toB = service.setFolder(cx, '/other');
    await untilFolder(service, '/other');
    let latest = toB;
    const folder = returnToA ? '/project' : '/other';
    if (returnToA) {
      latest = service.setFolder(cx, folder);
      await untilFolder(service, folder);
    }
    blocked.leave();
    assert.equal((await opening).error, 'disconnected');
    assert.deepEqual(await latest, { ok: true, path: folder });
    await toB;
    assert.equal(service.snapshot().bridges.default.state, 'ready');
    assert.equal(JSON.parse(host.discovery).cwd, folder);
    const mutations = host.hc.filter(([op]) => op !== 'ls');
    if (phase === 'Reap') assert.deepEqual(mutations.map(([op]) => op), ['run']);
    else {
      assert.deepEqual(mutations.map(([op]) => op), ['run', 'kill', 'rm', 'run']);
      assert.deepEqual(mutations.slice(1, 3), [['kill', 't-stale'], ['rm', 't-stale']]);
    }
    assert.deepEqual(host.steps.filter(([op]) => op === 'attach'), [['attach', host.replacement.token]]);
  });
}

for (const returnToA of [false, true]) {
  test(`late recovery hello and callbacks cannot route a prompt to the old bridge (${returnToA ? 'A→B→A' : 'A→B'})`, async () => {
    const host = defaultFixture();
    host.lateToken = host.oldToken;
    host.oldToken = null; // first attach succeeds
    host.shutdownReply = { ok: true };
    host.exitState = 'gone';
    host.unlinkEarly = true;
    const service = await import(`../mods/lazuli/sys/assistant.js?late-hello-${returnToA}`);
    assert.deepEqual(await service.open(cx), { ok: true });
    const original = host.clients[0];
    const blocked = barrier();
    host.pauseHello = blocked.pause;
    original.close();
    const recovering = original.callbacks.onEnd({ reason: 'eof' }, cx);
    await blocked.reached;
    const oldRecovery = host.clients[1];

    assert.deepEqual(await service.setFolder(cx, '/other'), { ok: true, path: '/other' });
    assert.deepEqual(host.steps.filter(([op]) => op === 'shutdown'), [['shutdown', original.d.token]]);
    const b = await service.newSession(cx);
    assert.deepEqual(b, { ok: true, key: 'default/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    assert.deepEqual(await service.send(cx, b.key, { text: 'B prompt while old hello is blocked' }), { ok: true });

    let key = b.key;
    if (returnToA) {
      host.commands.delete(host.oldPid);
      host.replacement = { ...host.replacement, pid: 106, token: 'c'.repeat(64) };
      assert.deepEqual(await service.setFolder(cx, '/project', { confirmed: true }), { ok: true, path: '/project' });
      const a = await service.newSession(cx);
      assert.equal(a.ok, true);
      key = a.key;
    }
    blocked.leave();
    await recovering;
    oldRecovery.callbacks.onRecord({ seq: 2, c: { kind: 'request', method: 'unsupported', id: 8 } }, cx);
    oldRecovery.callbacks.onEvent({ seq: 3, ev: 'gap' }, cx);
    await oldRecovery.callbacks.onEnd({ reason: 'eof' }, cx);
    assert.equal(service.snapshot().bridges.default.state, 'ready');
    assert.equal(service.session('default/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), null);
    assert.deepEqual(await service.send(cx, key, { text: 'Current prompt after old hello' }), { ok: true });
    const sent = host.requests.filter(([, , method]) => method === 'session/prompt');
    assert.deepEqual(sent.map(([cwd, token]) => [cwd, token]), [
      ['/other', 'b'.repeat(64)], [returnToA ? '/project' : '/other', (returnToA ? 'c' : 'b').repeat(64)],
    ]);
    assert.ok(host.requests.every(([, token]) => token !== original.d.token));
  });
}

for (const ambiguousFirst of [false, true]) {
  test(`launch recognizes the exact finished receipt${ambiguousFirst ? ' after ambiguous listings' : ' on the first poll'}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const host = fixture();
    host.address = 't-finished-own';
    const unrelated = { state: 'finished', address: 't-unrelated', reason: 'killed' };
    const exact = { state: 'finished', address: host.address, reason: 'exited' };
    const listed = (...terms) => ({ code: 0, stdout: JSON.stringify(terms) });
    host.listingReplies = [...(ambiguousFirst ? [{ code: 1, stdout: '', stderr: 'unavailable' }, listed(unrelated)] : []),
      listed(unrelated, exact)];
    let sleeps = 0;
    const result = await bridge.launch({ sleep: ms => {
      if (ms === 45000) return new Promise(() => {});
      sleeps++;
      t.mock.timers.tick(ms);
      return Promise.resolve();
    } }, {
      profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv, snapshot: await bridge.readDiscovery(profile), valid: () => true,
    });
    assert.deepEqual(result, { error: 'bridge-launch-failed', detail: 'the bridge ended (exited)' });
    assert.equal(sleeps, ambiguousFirst ? 21 : 1);
    assert.deepEqual(host.hc.filter(([op]) => op === 'rm' || op === 'kill'), [['rm', host.address]]);
  });
}

test('a hello identifying another folder cannot authorize attachment or shutdown', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  host.helloOverride = { cwd: '/another' };
  const service = await import('../mods/lazuli/sys/assistant.js?mismatched-hello');
  assert.deepEqual(await service.open(cx), { error: 'auth' });
  assert.equal(host.clients[0].open, false);
  assert.ok(host.steps.every(([op]) => op !== 'shutdown' && op !== 'launch'));
});

test('the real ACP client does not write an ordinary request after its connection outlives the folder', async () => {
  const host = fixture();
  const blocked = barrier();
  const writes = [];
  let closed = 0;
  let online = true;
  const sock = { write: async piece => { writes.push(piece); }, close: () => { closed++; },
    read: async () => Buffer.from('{"ok":true}\n') };
  host.connect = async () => { await blocked.pause(); return sock; };
  const { AcpClient } = await import('../mods/lazuli/sys/acp-client.js?scoped-write');
  const client = new AcpClient({ profile, discovery: ready, nonce: 'scope', valid: () => online });
  client.open = true;
  const tcx = { sleep: () => new Promise(() => {}) };
  const send = client.send(tcx, { jsonrpc: '2.0', id: 1, method: 'session/prompt' });
  await blocked.reached;
  online = false;
  client.close();
  blocked.leave();
  assert.deepEqual(await send, { error: 'disconnected' });
  assert.deepEqual(writes, []);
  assert.equal(closed, 1);
  assert.deepEqual(await client.shutdown(tcx), { ok: true });
  assert.deepEqual(writes.map(piece => JSON.parse(piece)), [{ op: 'shutdown', token: ready.token }]);
});

test('a replaced subscriber relinquishes shutdown authority; its successor keeps the active turn', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  const former = await import('../mods/lazuli/sys/assistant.js?formerly-owned');
  const successor = await import('../mods/lazuli/sys/assistant.js?new-subscriber');
  assert.deepEqual(await former.open(cx), { ok: true });
  const chat = await former.newSession(cx);
  assert.equal(chat.ok, true);
  assert.deepEqual(await former.send(cx, chat.key, { text: 'turn started before replacement' }), { ok: true });
  const active = Object.keys(former.session(chat.key).inflight);
  assert.equal(active.length, 1);
  assert.equal(former.session(chat.key).stale, false);
  const [, , , prompt] = host.requests.at(-1);
  host.helloRunning = [{ id: active[0], sessionId: prompt.sessionId, prompt: prompt.prompt }];
  assert.deepEqual(await successor.open(cx), { ok: true });
  assert.deepEqual(Object.keys(successor.session(chat.key).inflight), active);
  const [oldClient, newClient] = host.clients;
  oldClient.close();
  await oldClient.callbacks.onEnd({ reason: 'replaced' }, cx);
  assert.equal(former.snapshot().bridges.default.state, 'off');
  assert.deepEqual(Object.keys(former.session(chat.key).inflight), []);
  assert.equal(former.session(chat.key).stale, true);
  assert.equal(former.session(chat.key).lastError?.message, 'disconnected');
  assert.deepEqual(Object.keys(successor.session(chat.key).inflight), active);
  const requests = host.requests.slice();
  host.replacement = null;
  host.address = 't-lock-refusal';
  host.finished = [{ state: 'finished', address: host.address, reason: 'exited' }];
  const completion = { seq: 3, c: { kind: 'result', id: active[0], result: { stopReason: 'end_turn' } } };
  oldClient.callbacks.onRecord(completion, cx);
  assert.equal(former.session(chat.key).lastError?.message, 'disconnected');
  assert.deepEqual(Object.keys(successor.session(chat.key).inflight), active);
  await former.setFolder(cx, '/other');
  assert.equal(former.snapshot().folder, '/other', 'the locally settled turn does not block switching');
  assert.ok(host.steps.every(([op]) => op !== 'shutdown'));
  assert.equal(JSON.parse(host.discovery).token, newClient.d.token);
  assert.equal(newClient.open, true);
  assert.deepEqual(Object.keys(successor.session(chat.key).inflight), active);
  const sessionId = prompt.sessionId;
  newClient.callbacks.onRecord({ seq: 2, c: { kind: 'update', sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'successor received the reply' } } } }, cx);
  newClient.callbacks.onRecord(completion, cx);
  assert.deepEqual(Object.keys(successor.session(chat.key).inflight), []);
  assert.equal(successor.session(chat.key).stale, false);
  assert.equal(successor.session(chat.key).lastError, null);
  assert.deepEqual(host.requests, requests, 'no cancel or other write to the successor');
});

test('opening again with a relinquished live discovery returns disconnected and leaves the bridge off', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  const former = await import('../mods/lazuli/sys/assistant.js?released-open');
  assert.deepEqual(await former.open(cx), { ok: true });
  const client = host.clients[0];
  client.close();
  await client.callbacks.onEnd({ reason: 'replaced' }, cx);
  const discovery = host.discovery;
  const activity = host.steps.length;

  assert.deepEqual(await former.open(cx), { error: 'disconnected' });
  assert.deepEqual(former.snapshot().bridges.default, { state: 'off' });
  assert.deepEqual(host.steps.slice(activity), [['probe', 'present']]);
  assert.deepEqual(host.hc, []);
  assert.deepEqual(host.requests, []);
  assert.equal(host.discovery, discovery);
});

test('a late replaced callback does not remove a newer client for the same profile', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  const service = await import('../mods/lazuli/sys/assistant.js?late-replaced');
  assert.deepEqual(await service.open(cx), { ok: true });
  const old = host.clients[0];
  assert.deepEqual(await service.retryBridge(cx, 'default'), { ok: true });
  await old.callbacks.onEnd({ reason: 'replaced' }, cx);
  assert.equal(service.snapshot().bridges.default.state, 'ready');
  assert.equal((await service.newSession(cx)).ok, true);
  assert.equal(host.clients.length, 2, 'the fast path still uses the newer client');
});

test('recovery preserves auth when hello identifies a different instance', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  const service = await import('../mods/lazuli/sys/assistant.js?recovery-auth');
  assert.deepEqual(await service.open(cx), { ok: true });
  const original = host.clients[0];
  host.helloOverride = { startedAt: 42 };
  original.close();
  await original.callbacks.onEnd({ reason: 'lost' }, cx);
  assert.deepEqual(service.snapshot().bridges.default, { state: 'error', error: 'auth' });
  assert.equal(host.clients[1].open, false);
  assert.ok(host.steps.every(([op]) => op !== 'shutdown' && op !== 'launch'));
});

test('stop retires a pending load; its late completion cannot clear a restarted load', async () => {
  const host = defaultFixture();
  host.oldToken = null;
  const old = barrier(), fresh = barrier();
  const service = await import('../mods/lazuli/sys/assistant.js?stop-load');
  const statusCx = { ...cx, sleep: ms => ms === 1000 ? new Promise(() => {}) : cx.sleep(ms) };
  service.start(statusCx);
  assert.deepEqual(await service.open(cx), { ok: true });
  const key = 'default/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  void host.clients[0].callbacks.onRecord({ seq: 2, c: { kind: 'update', sessionId: key.split('/')[1],
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial history' } } } }, cx);
  host.loadReplies = [
    async () => { await old.pause(); return { ok: true, result: { models: { currentModelId: 'old' } } }; },
    async () => { await fresh.pause(); return { ok: true, result: { models: { currentModelId: 'new' } } }; },
  ];
  const loading = service.select(cx, key);
  await old.reached;
  assert.equal(service.session(key).loading, true);
  service.stop();
  assert.equal(service.session(key).loading, false);
  assert.equal(service.session(key).stale, true);
  service.start(statusCx);
  assert.deepEqual(await service.open(cx), { ok: true });
  const reloaded = service.select(cx, key);
  await fresh.reached;
  old.leave();
  assert.deepEqual(await loading, { error: 'disconnected' });
  assert.equal(service.session(key).loading, true);
  const sameLoad = service.select(cx, key);
  fresh.leave();
  assert.deepEqual(await reloaded, { ok: true });
  assert.deepEqual(await sameLoad, { ok: true });
  assert.equal(service.session(key).loading, false);
  assert.equal(service.session(key).stale, false);
  assert.equal(service.session(key).models.currentModelId, 'new');
  assert.equal(host.requests.filter(([, , method]) => method === 'session/load').length, 2);
  service.stop();
});

test('a hung finished-terminal listing cannot extend the elapsed launch deadline or spend a late row', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const host = fixture();
  host.address = 't-deadline-own';
  const listing = barrier(), deadline = barrier();
  host.pauseListing = listing.pause;
  host.finished = [{ address: host.address, state: 'finished', reason: 'exited' }];
  const launch = bridge.launch({ sleep: ms => {
    if (ms === 45000) return deadline.pause();
    t.mock.timers.tick(ms);
    return Promise.resolve();
  } }, {
    profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv, snapshot: await bridge.readDiscovery(profile), valid: () => true,
  });
  await listing.reached;
  assert.equal(Date.now(), 100);
  t.mock.timers.tick(44900);
  deadline.leave();
  assert.deepEqual(await launch, { error: 'bridge-timeout', detail: 'bridge did not start in 45 s' });
  assert.equal(Date.now(), 45000);
  await new Promise(setImmediate); // receipt cleanup is outside the launch deadline
  assert.deepEqual(host.hc.filter(([op]) => op === 'kill' || op === 'rm'), [['kill', host.address], ['rm', host.address]]);
  listing.leave();
  await new Promise(setImmediate);
  assert.deepEqual(host.hc.filter(([op]) => op === 'kill' || op === 'rm'), [['kill', host.address], ['rm', host.address]]);
});

test('an hc run receipt returned after the deadline is the only terminal cleaned up', async () => {
  const host = fixture();
  host.address = 't-late-own';
  const run = barrier(), deadline = barrier();
  host.pauseRun = run.pause;
  const launch = bridge.launch({ sleep: () => deadline.pause() }, {
    profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv, snapshot: await bridge.readDiscovery(profile), valid: () => true,
  });
  await run.reached;
  deadline.leave();
  assert.equal((await launch).error, 'bridge-timeout');
  assert.deepEqual(host.hc.map(([op]) => op), ['run']);
  run.leave();
  await new Promise(setImmediate);
  assert.deepEqual(host.hc.slice(1), [['kill', host.address], ['rm', host.address]]);
});
