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
  export const checking = () => false;
  export const shared = () => null;
  export const setShared = () => {};
  export const pickFolder = () => null;
  export const window = () => null;
  export const t = key => key;
  export const settings = () => state.settings;
  export const updateSettings = async fn => { state.settings = fn(state.settings); };
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
    constructor({ discovery }) { this.d = discovery; this.pid = discovery.pid; }
    async connect(cx, since, { ready }) {
      state.steps.push(['attach', this.d.token]);
      if (this.d.token === state.oldToken) return { error: 'bridge-timeout' };
      this.open = true;
      ready({});
      return { ok: true };
    }
    close() { this.open = false; }
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
      return { code: 0, stdout: JSON.stringify([...state.live.filter(t => t.labels?.[args.at(-1).split('=')[0]]), ...state.finished]) };
    }
    if (args[0] === 'run') {
      if (state.pauseRun) await state.pauseRun();
      if (state.replaceOnExit) return { code: 1, stderr: 'discovery changed before reservation', stdout: '' };
      if (state.replacement) {
        state.steps.push(['launch']);
        state.discovery = JSON.stringify({ ...state.replacement, startedAt: Date.now(), launchId: args[args.indexOf('--launch-id') + 1] });
      }
      return { code: 0, stdout: JSON.stringify({ address: state.address ?? state.live[0].address }) };
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
  const launched = await bridge.launch({ sleep: async () => {} }, {
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
  sleep: async () => {},
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

for (const phase of ['Reap', 'Run']) {
  test(`folder changes A→B→A while ${phase.toLowerCase()} is pending invalidate that launch`, async () => {
    const host = defaultFixture();
    host.discovery = JSON.stringify({ version: 1, pid: 100, error: { code: 'init-failed' } });
    host.live.unshift({ state: 'live', address: 't-unrelated', pid: 104, labels: { 'lazuli.assistant.v2': 'default' } });
    host.address = 't-new';
    const blocked = barrier();
    host[`pause${phase}`] = blocked.pause;
    const service = await import(`../mods/lazuli/sys/assistant.js?generation-${phase}`);
    const opening = service.open(cx);
    await blocked.reached;
    const toB = service.setFolder(cx, '/other');
    await untilFolder(service, '/other');
    const backToA = service.setFolder(cx, '/project');
    await untilFolder(service, '/project');
    blocked.leave();
    assert.equal((await opening).error, 'disconnected');
    await Promise.all([toB, backToA]);
    const mutations = host.hc.filter(([op]) => op !== 'ls');
    if (phase === 'Reap') assert.deepEqual(mutations, []);
    else {
      assert.deepEqual(mutations.map(([op]) => op), ['run', 'kill', 'rm']);
      assert.deepEqual(mutations.slice(1), [['kill', 't-new'], ['rm', 't-new']]);
    }
    assert.ok(host.steps.every(([op]) => op !== 'attach'));
  });
}
