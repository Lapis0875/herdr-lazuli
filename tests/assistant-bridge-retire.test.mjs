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
  export const settings = () => ({ assistant: { folder: '/project' } });
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
  }
  export async function shutdownBridge(cx, d) {
    state.steps.push(['shutdown', d.token]);
    state.shutdownRequested = true;
    if (state.unlinkEarly) state.discovery = null;
    return state.shutdownReply;
  }
  export async function hc(args) {
    state.hc.push(args);
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify([...state.live, ...state.finished]) };
    if (args[0] === 'run') {
      if (state.replacement) {
        state.steps.push(['launch']);
        state.discovery = JSON.stringify({ ...state.replacement, startedAt: Date.now() });
      }
      return { code: 0, stdout: JSON.stringify({ address: state.live[0].address }) };
    }
    return { code: 0, stdout: '' };
  }
  export async function exec(command, args) {
    state.exec.push([command, args]);
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
    if (command === '/bin/rm') { state.steps?.push(['retire']); state.discovery = null; }
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
const listing = ['ls', '--all', '--json', '--label', `lazuli.assistant=${profile}`];

function fixture() {
  const host = {
    live: [{ state: 'live', address: 't-live', pid: 101, labels: { [bridge.LABEL]: profile } }],
    finished: [{ state: 'finished', address: 't-finished' }],
    commands: new Map(), hc: [], exec: [],
  };
  use(host);
  return host;
}

test('retirement does not inspect or signal a different bridge with the real launch command', async () => {
  const host = fixture();
  host.discovery = JSON.stringify({ ...ready, pid: 101, agentPid: 102, startedAt: Date.now() });
  const launched = await bridge.launch({ sleep: async () => {} }, { profile, folder: ready.cwd, herdrPid: ready.herdrPid, argv });
  assert.equal(launched.address, 't-live');
  const launch = host.hc.find(args => args[0] === 'run');
  const command = launch.slice(launch.indexOf('--') + 1);
  assert.equal(command[1], bridge.bridgeScript());
  assert.deepEqual(command.slice(-argv.length - 2), ['--agent', '--', ...argv]);
  host.commands.set(101, command.join(' '));
  host.hc.length = host.exec.length = 0;

  host.discovery = JSON.stringify({ ...ready, startedAt: 1 });
  await bridge.retire(profile, await bridge.readDiscovery(profile));
  assert.deepEqual(host.hc, [listing, ['rm', 't-finished']]);
  assert.deepEqual(host.exec, [['/bin/rm', ['-f', bridge.bridgePaths(profile).discovery]]]);
});

test('a legacy record and a recycled bridge PID do not authorize terminal kill', async () => {
  const host = fixture();
  host.discovery = JSON.stringify({ ...ready, pid: 101, agentPid: 102, argv: undefined, startedAt: 1 });
  host.commands.set(101, '/different/bridge');
  const discovery = await bridge.readDiscovery(profile);
  assert.equal(discovery.state, 'ready');
  assert.equal(discovery.argv, null);

  await bridge.retire(profile, discovery);
  assert.deepEqual(host.hc, [listing, ['rm', 't-finished']]);
  assert.deepEqual(host.exec, [['/bin/rm', ['-f', bridge.bridgePaths(profile).discovery]]]);

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
  host.live = [{ state: 'live', address: 't-new', pid: 102, labels: { [bridge.LABEL]: 'default' } }];
  host.oldPid = defaultReady.pid;
  host.oldToken = defaultReady.token;
  host.commands.set(host.oldPid, 'bridge');
  host.discovery = JSON.stringify({ ...defaultReady, startedAt: 1 });
  host.replacement = { ...defaultReady, pid: 102, agentPid: 103, token: 'b'.repeat(64) };
  host.steps = [];
  return host;
};

test('a matching bridge without hello exits before retirement and replacement', async () => {
  const host = defaultFixture();
  host.shutdownReply = { ok: true };
  host.exitState = 'gone';
  const service = await import('../mods/lazuli/sys/assistant.js?confirmed-exit');
  assert.deepEqual(await service.open(cx), { ok: true });
  assert.deepEqual(host.steps, [
    ['probe', 'present'], ['attach', host.oldToken], ['shutdown', host.oldToken], ['probe', 'gone'],
    ['retire'], ['launch'], ['attach', host.replacement.token],
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
  assert.equal((await service.open(cx)).error, 'disconnected');
  assert.ok(host.steps.every(([op]) => op !== 'retire' && op !== 'launch'));
  assert.equal(host.discovery, host.replaceOnExit);
});
