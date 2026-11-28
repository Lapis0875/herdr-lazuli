import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL, STATE_DIR, AUTOSTART_FILE, ENDPOINT_FILE, REMEMBER_FILE, LOG_FILE, GET_ARGS, KILL_ARGS, VERBS, STATUS, LABELED, ERRORS,
  launcherConfig, autostartState, rememberedConfig, rememberText, endpointOf, pidAlive, reasonOf, terminalState, baseOf, chip,
  paletteCommands, allowed, onPlan, offPlan, launcherArgs, settled, labelKey, tipKey, whyKey,
} from '../mods/lazuli/core/relay-chip.js';
import { fragments } from '../mods/lazuli/core/catalog/index.js';

const ICONS = fileURLToPath(new URL('../mods/lazuli/ui/icons/', import.meta.url));
// ui/kit.js toneColor's names.
const TONES = new Set(['primary', 'secondary', 'default', 'tertiary', 'accent', 'accent2', 'onAccent', 'working', 'blocked', 'done', 'idle', 'unknown', 'success', 'warning', 'error', 'info']);
const LAUNCHER = '/Users/me/Agent-Tools/herdr-relay/packages/bridge/bin/herdr-relay';
const PATH = '/Users/me/.deno/bin:/opt/homebrew/bin:/usr/bin:/bin';
const CONFIG = { launcher: LAUNCHER, path: PATH };
const OTHER = { launcher: '/opt/herdr-relay/packages/bridge/bin/herdr-relay', path: '/usr/bin:/bin' };
const AUTOSTART = JSON.stringify({ v: 1, ...CONFIG });
const has = (key) => assert.ok(fragments.shell.en[key] && fragments.shell.ko[key], key);

// What sys/relay.js reads, in the shapes it hands to the core.
const live = { kind: 'live', address: 't9c' };
const none = { kind: 'none', state: null };
const O = (over = {}) => ({ present: true, terminal: none, autostart: { kind: 'absent' }, endpoint: null, answering: false, remembered: null, ...over });
const SAMPLES = {
  on: O({ terminal: live, autostart: autostartState(AUTOSTART) }),
  off: O({ autostart: autostartState(AUTOSTART) }),
  external: O({ answering: true, endpoint: { port: 7781, pid: 28143 } }),
  unset: O(),
  unknown: O({ terminal: { kind: 'unknown', reason: 'core not running' } }),
};

test('names and the exact invocations', () => {
  assert.equal(TERMINAL, 'herdr-relay');
  assert.equal(STATE_DIR, '.herdr/herdr-relay');
  assert.deepEqual([AUTOSTART_FILE, ENDPOINT_FILE, REMEMBER_FILE, LOG_FILE], ['autostart.json', 'mirror-endpoint.json', 'relay.json', 'Library/Logs/herdr-relay.log']);
  assert.deepEqual(GET_ARGS, ['get', 'herdr-relay', '--json']);
  assert.deepEqual(KILL_ARGS, ['kill', 'herdr-relay']);
  assert.deepEqual(VERBS, ['on', 'off', 'status']);
  for (const verb of ['on', 'off', 'run']) assert.deepEqual(launcherArgs(CONFIG, verb), [`PATH=${PATH}`, '/bin/sh', LAUNCHER, 'autostart', verb]);
});

test('autostart.json and the remembered launcher are read as the mirror mod reads them', () => {
  assert.deepEqual(autostartState(null), { kind: 'absent' });
  assert.deepEqual(autostartState(undefined), { kind: 'absent' });
  assert.deepEqual(autostartState(AUTOSTART), { kind: 'ok', config: CONFIG });
  assert.deepEqual(autostartState(JSON.stringify({ v: 1, ...CONFIG, extra: true })), { kind: 'ok', config: CONFIG });
  const bad = ['', 'not json', '[]', 'null', JSON.stringify({ v: 2, ...CONFIG }), JSON.stringify({ v: '1', ...CONFIG }), JSON.stringify({ ...CONFIG }),
    JSON.stringify({ v: 1, launcher: 'packages/bridge/bin/herdr-relay', path: PATH }), JSON.stringify({ v: 1, launcher: '/usr/local/bin/herdr-relay', path: PATH }),
    JSON.stringify({ v: 1, launcher: `${LAUNCHER}\n`, path: PATH }), JSON.stringify({ v: 1, launcher: LAUNCHER, path: '' }),
    JSON.stringify({ v: 1, launcher: LAUNCHER, path: 'a\tb' }), JSON.stringify({ v: 1, launcher: LAUNCHER, path: 'x'.repeat(8193) }), JSON.stringify({ v: 1, launcher: LAUNCHER })];
  for (const text of bad) assert.deepEqual(autostartState(text), { kind: 'invalid' }, text.slice(0, 80));
  assert.deepEqual(launcherConfig({ launcher: LAUNCHER, path: 'x'.repeat(8192) })?.launcher, LAUNCHER);
  const saved = rememberText(CONFIG, 1795767233782);
  assert.ok(saved.endsWith('\n'));
  assert.deepEqual(JSON.parse(saved), { v: 1, launcher: LAUNCHER, path: PATH, at: 1795767233782 });
  assert.deepEqual(rememberedConfig(saved), CONFIG);
  for (const text of [null, '', '{}', JSON.stringify({ v: 2, ...CONFIG }), JSON.stringify({ v: 1, launcher: '/x', path: PATH })]) assert.equal(rememberedConfig(text), null);
});

test('endpoint file, pid check and hc get results', () => {
  assert.deepEqual(endpointOf('{"v":1,"port":7781,"pid":28143}'), { port: 7781, pid: 28143 });
  for (const text of [null, '', '{', '{"port":7781}', '{"port":0,"pid":1}', '{"port":65536,"pid":1}', '{"port":"7781","pid":1}', '{"port":7781,"pid":-1}', '{"port":7781.5,"pid":1}']) assert.equal(endpointOf(text), null, String(text));
  assert.equal(pidAlive({ code: 0, stdout: '28143\n', stderr: '' }, 28143), true);
  assert.equal(pidAlive({ code: 0, stdout: '  28143\n', stderr: '' }, 28143), true);
  assert.equal(pidAlive({ code: 1, stdout: '', stderr: '' }, 28143), false);
  assert.equal(pidAlive({ code: 0, stdout: '999\n' }, 28143), false);
  assert.equal(pidAlive(null, 1), false);
  // `hc get herdr-relay --json` as it printed on the Mac (trimmed), and its not_found error on stderr (exit 3).
  assert.deepEqual(terminalState({ code: 0, stdout: '{"address":"t9c","name":"herdr-relay","state":"live","pid":28121}', stderr: '' }), { kind: 'live', address: 't9c' });
  assert.deepEqual(terminalState({ code: 0, stdout: '{"address":"t9c","state":"exited","exit_code":1}', stderr: '' }), { kind: 'none', state: 'exited' });
  assert.deepEqual(terminalState({ code: 3, stdout: '', stderr: '{"error":{"hint":"see `hc ls --all`","kind":"not_found","message":"no terminal \\"herdr-relay\\""}}\n' }), { kind: 'none', state: null });
  assert.deepEqual(terminalState({ code: 1, stdout: '', stderr: '{"error":{"kind":"unavailable","message":"herdr-core is not running"}}' }), { kind: 'unknown', reason: 'herdr-core is not running' });
  assert.deepEqual(terminalState({ code: 0, stdout: 'not json', stderr: '' }), { kind: 'unknown', reason: 'hc get printed no state' });
  assert.deepEqual(terminalState({ error: 'spawn hc ENOENT' }), { kind: 'unknown', reason: 'spawn hc ENOENT' });
  assert.equal(terminalState(null).kind, 'unknown');
});

test('a failure gives its last line', () => {
  assert.equal(reasonOf({ code: 1, stdout: 'Autostart is on.\n', stderr: 'warn\nherdr-relay: autostart: ~/.herdr/herdr-relay/autostart.json has version 2\n\n' }), 'herdr-relay: autostart: ~/.herdr/herdr-relay/autostart.json has version 2');
  assert.equal(reasonOf({ code: 1, stdout: 'only stdout\n', stderr: '  \n' }), 'only stdout');
  assert.equal(reasonOf({ code: 2, stdout: '', stderr: '' }), 'exit 2');
  assert.equal(reasonOf({ code: 3, stdout: '', stderr: '{"error":{"kind":"not_found","message":"t9c was removed"}}' }), 't9c was removed');
  const long = reasonOf({ code: 1, stderr: 'x'.repeat(500) });
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
  assert.equal(reasonOf(null), '');
});

test('each status: its source, icon and tone', () => {
  const samples = { ...SAMPLES, starting: [SAMPLES.off, { busy: 'starting' }], stopping: [SAMPLES.on, { busy: 'stopping' }], error: [SAMPLES.off, { error: { action: 'on', code: 'exit', detail: 'boom', base: 'off' } }] };
  assert.deepEqual(Object.keys(STATUS).sort(), Object.keys(samples).sort());
  for (const [status, spec] of Object.entries(STATUS)) {
    assert.ok(existsSync(`${ICONS}${spec.icon}.svg`), spec.icon);
    assert.ok(TONES.has(spec.tone), spec.tone);
    const [obs, opts] = Array.isArray(samples[status]) ? samples[status] : [samples[status], {}];
    const c = chip(obs, opts);
    assert.equal(c.status, status);
    assert.deepEqual([c.icon, c.tone], [spec.icon, spec.tone]);
    assert.equal(c.busy, status === 'starting' || status === 'stopping');
  }
  assert.equal(STATUS.on.tone, 'accent', 'only on is active styling');
  assert.deepEqual(Object.entries(STATUS).filter(([, s]) => s.tone === 'accent').map(([k]) => k), ['on']);
  assert.ok(existsSync(`${ICONS}tablet-smartphone.svg`));
});

test('the settled status follows the sources in order', () => {
  // A live Herdr-run terminal is on, whatever else is true.
  assert.equal(baseOf(O({ terminal: live, answering: true, autostart: { kind: 'absent' } })), 'on');
  assert.equal(chip(SAMPLES.on).address, 't9c');
  // Not live: a bridge that answers is external; hc failing is unknown before anything else.
  assert.equal(baseOf(O({ answering: true, autostart: autostartState(AUTOSTART), remembered: CONFIG })), 'external');
  assert.equal(baseOf(O({ terminal: { kind: 'unknown', reason: 'x' }, answering: true })), 'unknown');
  assert.equal(chip(SAMPLES.unknown).reason, 'core not running');
  // A finished terminal is not running.
  assert.equal(baseOf(O({ terminal: { kind: 'none', state: 'exited' }, autostart: autostartState(AUTOSTART) })), 'off');
  // Off needs a launcher: autostart.json's or the remembered one; neither is "not set up".
  assert.equal(baseOf(O({ remembered: CONFIG })), 'off');
  assert.equal(baseOf(O({ autostart: { kind: 'invalid' }, remembered: CONFIG })), 'off');
  assert.equal(baseOf(O({ autostart: { kind: 'invalid' } })), 'unset');
  assert.equal(baseOf(O({ remembered: { launcher: 'x', path: PATH } })), 'unset');
  assert.equal(chip(SAMPLES.off).autostart, true);
  assert.equal(chip(O({ remembered: CONFIG })).autostart, false);
  // Nothing to show: no state folder and nothing remembered, no read yet, or a device.
  assert.equal(chip({ present: false }), null);
  assert.equal(chip(null), null);
  for (const obs of Object.values(SAMPLES)) assert.equal(chip(obs, { device: true }), null);
  assert.equal(chip(SAMPLES.on, { device: true, busy: 'stopping' }), null);
  const frozen = Object.freeze(O({ terminal: Object.freeze({ ...live }), autostart: Object.freeze(autostartState(AUTOSTART)) }));
  chip(frozen);
  assert.equal(frozen.terminal.kind, 'live');
});

test('actions per status: never for an outside bridge, while busy, or on a device', () => {
  assert.deepEqual(chip(SAMPLES.on).actions, ['off']);
  assert.deepEqual(chip(SAMPLES.off).actions, ['on']);
  for (const status of ['external', 'unset', 'unknown']) assert.deepEqual(chip(SAMPLES[status]).actions, [], status);
  for (const busy of ['starting', 'stopping']) for (const obs of Object.values(SAMPLES)) assert.deepEqual(chip(obs, { busy }).actions, []);
  assert.deepEqual(paletteCommands(chip(SAMPLES.on)), ['off']);
  assert.deepEqual(paletteCommands(chip(SAMPLES.external)), []);
  assert.deepEqual(paletteCommands(chip(SAMPLES.on, { device: true })), []);
  assert.deepEqual(paletteCommands(null), []);
  assert.equal(allowed(chip(SAMPLES.on), 'off'), true);
  assert.equal(allowed(chip(SAMPLES.on), 'on'), false);
  assert.equal(allowed(chip(SAMPLES.off), 'on'), true);
  assert.equal(allowed(chip(SAMPLES.off), 'off'), false);
  for (const verb of ['on', 'off']) {
    assert.equal(allowed(chip(SAMPLES.external), verb), false, `external ${verb}`);
    assert.equal(allowed(chip(SAMPLES.unset), verb), false);
    assert.equal(allowed(chip(SAMPLES.on, { device: true }), verb), false, `device ${verb}`);
    assert.equal(allowed(chip(SAMPLES.off, { busy: 'starting' }), verb), false);
  }
  assert.equal(allowed(chip(SAMPLES.external), 'status'), true);
  assert.equal(allowed(null, 'status'), false);
  // A chip copy is not the table: changing it does not change the next chip.
  chip(SAMPLES.on).actions.push('on');
  assert.deepEqual(chip(SAMPLES.on).actions, ['off']);
});

test('a failure shows until the settled status it left changes, and offers that status\'s action', () => {
  const failedOn = { action: 'on', code: 'exit', detail: 'herdr-relay: autostart: PATH is unset or empty', base: 'off' };
  const c = chip(SAMPLES.off, { error: failedOn });
  assert.equal(c.status, 'error');
  assert.equal(c.base, 'off');
  assert.deepEqual(c.error, { action: 'on', code: 'exit', detail: failedOn.detail, seconds: null });
  assert.deepEqual(c.actions, ['on'], 'try again');
  assert.equal(chip(SAMPLES.on, { error: failedOn }).status, 'on', 'the mirror mod started it meanwhile');
  const failedOff = { action: 'off', code: 'timeout', detail: null, seconds: 15, base: 'on' };
  assert.deepEqual(chip(SAMPLES.on, { error: failedOff }).actions, ['off']);
  assert.equal(chip(SAMPLES.on, { error: failedOff }).error.seconds, 15);
  const blocked = { action: 'on', code: 'timeout', detail: null, seconds: 30, base: 'external' };
  assert.equal(chip(SAMPLES.external, { error: blocked }).status, 'error');
  assert.deepEqual(chip(SAMPLES.external, { error: blocked }).actions, [], 'an outside bridge is never offered');
  for (const bad of [{ ...failedOn, action: 'status' }, { ...failedOn, code: 'weird' }, { ...failedOn, base: undefined }, 'boom', null]) assert.equal(chip(SAMPLES.off, { error: bad }).status, 'off', JSON.stringify(bad));
  assert.equal(chip(SAMPLES.off, { busy: 'starting', error: failedOn }).status, 'starting', 'busy wins');
  assert.deepEqual(ERRORS, ['exit', 'spawn', 'timeout', 'remember']);
});

test('what on and off run, and when a fresh read shows them done', () => {
  assert.deepEqual(onPlan(SAMPLES.off), CONFIG);
  assert.deepEqual(onPlan(O({ autostart: autostartState(AUTOSTART), remembered: OTHER })), CONFIG, 'the file wins');
  assert.deepEqual(onPlan(O({ autostart: { kind: 'invalid' }, remembered: OTHER })), OTHER);
  assert.equal(onPlan(SAMPLES.unset), null);
  assert.deepEqual(offPlan(autostartState(AUTOSTART), OTHER), { remember: CONFIG, autostartOff: CONFIG });
  assert.deepEqual(offPlan({ kind: 'invalid' }, OTHER), { remember: null, autostartOff: OTHER });
  assert.deepEqual(offPlan({ kind: 'invalid' }, null), { remember: null, autostartOff: null });
  assert.deepEqual(offPlan({ kind: 'absent' }, OTHER), { remember: null, autostartOff: null }, 'no file: nothing to turn off, only hc kill');
  assert.equal(settled('on', O({ terminal: live, answering: true })), true);
  assert.equal(settled('on', O({ terminal: live, answering: false })), false, 'live but not answering yet');
  assert.equal(settled('on', O({ answering: true })), false, 'an outside bridge is not ours');
  assert.equal(settled('off', O()), true);
  assert.equal(settled('off', O({ answering: true })), true, 'ours stopped; an outside one may remain');
  assert.equal(settled('off', O({ terminal: live })), false);
  assert.equal(settled('off', O({ terminal: { kind: 'unknown', reason: 'x' } })), false);
  assert.equal(settled('status', O()), false);
});

test('every text the chip, its menu and the palette use exists in both languages', () => {
  for (const status of Object.keys(STATUS)) {
    has(`shell.relay.state.${status}`);
    const [obs, opts] = status === 'starting' || status === 'stopping' ? [SAMPLES.off, { busy: status }] : status === 'error' ? [SAMPLES.off, { error: { action: 'on', code: 'exit', base: 'off' } }] : [SAMPLES[status], {}];
    const c = chip(obs, opts);
    assert.equal(labelKey(c), LABELED.includes(status) ? `shell.relay.label.${status}` : null, status);
    if (labelKey(c)) has(labelKey(c));
    has(tipKey(c));
  }
  assert.deepEqual(LABELED, ['on', 'starting', 'stopping', 'external', 'error']);
  for (const action of ['on', 'off']) {
    has(`shell.relay.tip.error.${action}`);
    has(`shell.relay.menu.${action}`);
    has(`shell.relay.cmd.${action}`);
    assert.match(fragments.shell.en[`shell.relay.cmd.${action}`], /^Relay: /);
    assert.match(fragments.shell.ko[`shell.relay.cmd.${action}`], /^Relay: /);
    for (const code of ERRORS) {
      const key = whyKey({ action, code });
      assert.equal(key, code === 'timeout' ? `shell.relay.why.timeout.${action}` : `shell.relay.why.${code}`);
      has(key);
    }
  }
  assert.equal(tipKey(chip(SAMPLES.off, { error: { action: 'off', code: 'exit', base: 'off' } })), 'shell.relay.tip.error.off');
  for (const key of ['tip.autostart', 'tip.open', 'menu.label', 'menu.heading', 'menu.refresh', 'menu.setup', 'menu.external', 'menu.log']) has(`shell.relay.${key}`);
  assert.equal(labelKey(null), null);
  assert.equal(tipKey(null), null);
  assert.equal(whyKey(null), null);
});
