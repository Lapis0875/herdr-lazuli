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
  export async function hc(args) {
    state.hc.push(args);
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify([...state.live, ...state.finished]) };
    if (args[0] === 'run') return { code: 0, stdout: JSON.stringify({ address: state.live[0].address }) };
    return { code: 0, stdout: '' };
  }
  export async function exec(command, args) {
    state.exec.push([command, args]);
    if (command === '/bin/ps') return { code: 0, stdout: state.commands.get(Number(args.at(-1))) ?? '' };
    if (command === '/bin/kill' && args[0] === '-0') return { code: state.commands.has(Number(args[1])) ? 0 : 1 };
    if (command === '/bin/sh' && args[2] === 'lazuli-lookup') return { code: 0, stdout: '/usr/bin/node' };
    return { code: 0, stdout: '' };
  }
`)}`;
register(`data:text/javascript,${encodeURIComponent(`
  export function resolve(specifier, context, next) {
    return specifier === 'herdr' ? { url: ${JSON.stringify(host)}, shortCircuit: true } : next(specifier, context);
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
  await bridge.awaitExit({ sleep: async () => {} }, profile, discovery.pid);
  assert.deepEqual(host.hc, [listing, ['rm', 't-finished']]);
  assert.ok(host.exec.length > 0);
  for (const call of host.exec) assert.deepEqual(call, ['/bin/kill', ['-0', '101']]);
});
