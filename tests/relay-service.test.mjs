import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';

// Run the real sys/relay.js against a fake Mac: no Herdr, hc, exec, file or socket I/O. The fake records every call in
// order, so the tests check the exact invocations and their sequence.
const host = `data:text/javascript,${encodeURIComponent(`
  export let state;
  export const use = (value) => { state = value; };
  export const checking = () => false;
  export const home = () => '/home/test';
  export const window = () => ({ visible: state.visible });
  export const dataDir = () => '/herdr/data/lazuli';
  export const debugLog = () => {};
  export const hostLocal = () => state.local;
  export const probeHost = () => { state.probes++; };
  export async function exists(path) { return state.dirs.has(path) || state.files.has(path); }
  export async function readTextFile(path) { return state.files.get(path) ?? null; }
  export async function writeTextFile(path, text, expected) {
    if ((state.files.get(path) ?? null) !== expected) throw new Error('changed underneath');
    if (state.writeFails) throw new Error(state.writeFails);
    state.calls.push(['write', path]);
    state.files.set(path, text);
    return null;
  }
  export async function hc(args) { state.calls.push(['hc', ...args]); return state.onHc(args); }
  export async function exec(command, args) { state.calls.push(['exec', command, ...args]); return state.onExec(command, args); }
  export default {
    connect: async (address, port) => {
      state.calls.push(['connect', address, port]);
      if (!state.listening) throw new Error('ECONNREFUSED');
      return { close() {} };
    },
  };
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    const service = context.parentURL?.includes('/sys/relay.js');
    if (service && ['herdr', 'net', 'fs/promises', './store.js', '../views/apps/snapshot.js'].includes(specifier)) {
      return { url: ${JSON.stringify(host)}, shortCircuit: true };
    }
    return next(specifier, context);
  }
`)}`, import.meta.url);
const { use } = await import(host);
const relay = await import('../mods/lazuli/sys/relay.js');

const DIR = '/home/test/.herdr/herdr-relay';
const AUTOSTART = `${DIR}/autostart.json`;
const ENDPOINT = `${DIR}/mirror-endpoint.json`;
const REMEMBERED = '/herdr/data/lazuli/relay.json';
const LAUNCHER = '/Users/me/herdr-relay/packages/bridge/bin/herdr-relay';
const PATH = '/Users/me/.deno/bin:/opt/homebrew/bin:/usr/bin:/bin';
const CONFIG_TEXT = JSON.stringify({ v: 1, launcher: LAUNCHER, path: PATH });
const NOT_FOUND = JSON.stringify({ error: { hint: 'see `hc ls --all`', kind: 'not_found', message: 'no terminal "herdr-relay"' } });
const launcherCall = (verb) => ['exec', '/usr/bin/env', `PATH=${PATH}`, '/bin/sh', LAUNCHER, 'autostart', verb];

// A fake clock: cx.sleep moves it, so confirming waits without real time.
let clock = 1_800_000_000_000;
Date.now = () => clock;
let tasks = [];
const cx = {
  spawn(body) {
    tasks.push(Promise.resolve().then(() => body(cx)));
    return { cancel() {} };
  },
  sleep: async (ms = 0) => { clock += ms; },
  timer: { every: () => ({ cancel() {} }) },
  notify() {},
};
async function settle() {
  while (tasks.length) {
    const now = tasks;
    tasks = [];
    await Promise.all(now);
  }
}

/** The Mac as herdr-relay leaves it: autostart on and the Herdr-run bridge live, unless `over` says otherwise. */
function mac(over = {}) {
  const s = {
    local: true, visible: true, probes: 0, calls: [], listening: true, alive: true, terminal: 'live', writeFails: null,
    dirs: new Set([DIR]), files: new Map([[AUTOSTART, CONFIG_TEXT], [ENDPOINT, JSON.stringify({ v: 1, port: 7781, pid: 28143 })]]),
    onHc(args) {
      if (args[0] === 'get') {
        if (s.terminal === 'broken') return { code: 1, stdout: '', stderr: JSON.stringify({ error: { kind: 'unavailable', message: 'herdr-core is not running' } }) };
        return s.terminal === 'live' ? { code: 0, stdout: JSON.stringify({ address: 't9c', name: 'herdr-relay', state: 'live' }), stderr: '' } : { code: 3, stdout: '', stderr: NOT_FOUND };
      }
      if (args[0] === 'kill') return s.kill();
      throw new Error(`unexpected hc ${args.join(' ')}`);
    },
    // --rm removes the terminal as the bridge exits, before hc answers.
    kill() {
      s.terminal = 'none';
      s.files.delete(ENDPOINT);
      return { code: 3, stdout: '', stderr: JSON.stringify({ error: { kind: 'not_found', message: 't9c was removed' } }) };
    },
    onExec(command, args) {
      if (command === '/bin/ps') return s.alive ? { code: 0, stdout: `${args[1]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
      if (command === '/usr/bin/env') return s.launcher(args.at(-1), args);
      throw new Error(`unexpected exec ${command}`);
    },
    launcher(verb) {
      if (verb === 'off') s.files.delete(AUTOSTART);
      if (verb === 'on') s.files.set(AUTOSTART, CONFIG_TEXT);
      if (verb === 'run') {
        s.terminal = 'live';
        s.files.set(ENDPOINT, JSON.stringify({ v: 1, port: 7781, pid: 30001 }));
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    ...over,
  };
  use(s);
  return s;
}

async function started(over) {
  const s = mac(over);
  relay.start(cx);
  await settle();
  s.calls.length = 0;
  return s;
}

test('a device: no status work, no chip, no action', async () => {
  const s = mac({ local: false });
  relay.start(cx);
  await settle();
  assert.equal(relay.view(), null);
  assert.deepEqual(relay.commands(), []);
  for (const verb of ['on', 'off', 'status']) relay.command(cx, verb);
  await settle();
  assert.deepEqual(s.calls, [], 'no hc, exec, read-side connect or write');
  assert.ok(s.probes >= 1, 'it asks the existing host probe');
});

test('on: the Herdr-run bridge is live', async () => {
  const s = mac();
  relay.start(cx);
  await settle();
  assert.deepEqual(s.calls, [['hc', 'get', 'herdr-relay', '--json']], 'a live terminal needs no ps or connect');
  const c = relay.view();
  assert.equal(c.status, 'on');
  assert.equal(c.address, 't9c');
  assert.deepEqual(relay.commands(), ['off']);
});

test('turn off: remember, autostart off, hc kill, then confirmed by a read', async () => {
  const s = await started();
  relay.command(cx, 'off');
  await settle();
  assert.deepEqual(s.calls, [
    ['hc', 'get', 'herdr-relay', '--json'],
    ['write', REMEMBERED],
    launcherCall('off'),
    ['hc', 'kill', 'herdr-relay'],
    ['hc', 'get', 'herdr-relay', '--json'],
  ]);
  assert.deepEqual(JSON.parse(s.files.get(REMEMBERED)), { v: 1, launcher: LAUNCHER, path: PATH, at: clock });
  assert.equal(s.files.has(AUTOSTART), false);
  const c = relay.view();
  assert.equal(c.status, 'off', 'the exit 3 of hc kill is not a failure');
  assert.equal(c.autostart, false);
  assert.deepEqual(relay.commands(), ['on'], 'the remembered launcher turns it on again');

  // On again with the remembered launcher and PATH; confirmed once the terminal is live and the bridge answers.
  s.calls.length = 0;
  relay.command(cx, 'on');
  await settle();
  assert.deepEqual(s.calls, [
    ['hc', 'get', 'herdr-relay', '--json'],
    launcherCall('on'),
    launcherCall('run'),
    ['hc', 'get', 'herdr-relay', '--json'],
    ['exec', '/bin/ps', '-p', '30001', '-o', 'pid='],
    ['connect', '127.0.0.1', 7781],
  ]);
  assert.equal(relay.view().status, 'on');
});

test('a bridge started outside Herdr is shown and never touched', async () => {
  const s = await started({ terminal: 'none', files: new Map([[ENDPOINT, JSON.stringify({ v: 1, port: 7781, pid: 4242 })]]) });
  relay.command(cx, 'status');
  await settle();
  assert.deepEqual(s.calls, [['hc', 'get', 'herdr-relay', '--json'], ['exec', '/bin/ps', '-p', '4242', '-o', 'pid='], ['connect', '127.0.0.1', 7781]]);
  assert.equal(relay.view().status, 'external');
  assert.deepEqual(relay.commands(), []);
  s.calls.length = 0;
  relay.command(cx, 'off');
  await settle();
  relay.command(cx, 'on');
  await settle();
  assert.ok(s.calls.every(([kind, ...rest]) => kind !== 'write' && !(kind === 'hc' && rest[0] === 'kill') && !(kind === 'exec' && rest[0] === '/usr/bin/env')), JSON.stringify(s.calls));
  // A stale endpoint (its pid gone) is not a bridge: the status is off or not set up.
  s.alive = false;
  s.calls.length = 0;
  relay.command(cx, 'status');
  await settle();
  assert.deepEqual(s.calls.map((c) => c[1]), ['get', '/bin/ps'], 'no connect without a live pid');
  assert.equal(relay.view().status, 'unset');
});

test('not set up, absent, unknown', async () => {
  await started({ terminal: 'none', files: new Map() });
  assert.equal(relay.view().status, 'unset');
  assert.deepEqual(relay.commands(), []);
  await started({ terminal: 'none', files: new Map(), dirs: new Set() });
  assert.equal(relay.view(), null, 'no herdr-relay on this Mac: no chip');
  await started({ terminal: 'broken' });
  const c = relay.view();
  assert.equal(c.status, 'unknown');
  assert.equal(c.reason, 'herdr-core is not running');
  assert.deepEqual(relay.commands(), []);
});

test('a failed program keeps its reason; the next action clears it', async () => {
  const s = await started({ terminal: 'none', files: new Map([[AUTOSTART, CONFIG_TEXT]]) });
  s.launcher = (verb) => (verb === 'on' ? { code: 2, stdout: '', stderr: 'herdr-relay: autostart: PATH is unset or empty; the mirror mod runs the launcher with this shell\'s PATH\n' } : { code: 0, stdout: '' });
  relay.command(cx, 'on');
  await settle();
  assert.deepEqual(s.calls.filter(([kind]) => kind === 'exec'), [launcherCall('on')], 'run is not tried after on failed');
  const c = relay.view();
  assert.equal(c.status, 'error');
  assert.deepEqual(c.error, { action: 'on', code: 'exit', detail: 'herdr-relay: autostart: PATH is unset or empty; the mirror mod runs the launcher with this shell\'s PATH', seconds: null });
  assert.deepEqual(relay.commands(), ['on'], 'try again');
  s.launcher = () => ({ code: 1, stdout: '', stderr: 'still broken' });
  relay.command(cx, 'on');
  await settle();
  assert.equal(relay.view().error.detail, 'still broken');
});

test('off that does not take is a timeout after 15 s; save failures stop before autostart off', async () => {
  let s = await started();
  s.kill = () => ({ code: 0, stdout: '', stderr: '' });
  const before = clock;
  relay.command(cx, 'off');
  await settle();
  const c = relay.view();
  assert.equal(c.status, 'error');
  assert.deepEqual([c.error.action, c.error.code, c.error.seconds], ['off', 'timeout', 15]);
  assert.ok(clock - before >= 15000);
  assert.deepEqual(relay.commands(), ['off']);

  s = await started({ writeFails: 'disk full' });
  relay.command(cx, 'off');
  await settle();
  assert.deepEqual(s.calls, [['hc', 'get', 'herdr-relay', '--json'], ['hc', 'get', 'herdr-relay', '--json']], 'no autostart off, no kill');
  assert.deepEqual([relay.view().status, relay.view().error.code, relay.view().error.detail], ['error', 'remember', 'disk full']);
  assert.equal(s.files.has(AUTOSTART), true);
});

test('one action at a time; the window hidden pauses the reads', async () => {
  const s = await started();
  relay.command(cx, 'off');
  relay.command(cx, 'off');
  await settle();
  assert.equal(s.calls.filter(([kind, op]) => kind === 'hc' && op === 'kill').length, 1);
  const hidden = mac({ visible: false });
  relay.start(cx);
  await settle();
  assert.deepEqual(hidden.calls, []);
  assert.equal(relay.view(), null, 'nothing read yet');
});
