import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MOD, STATE_KEY, HOST, STATUS, LID, BLOCKED, COMMANDS, usable, timeLeft, chip, paletteCommands, commandKey } from '../mods/lazuli/core/caffeinate-chip.js';
import { fragments } from '../mods/lazuli/core/catalog/index.js';

const ICONS = fileURLToPath(new URL('../mods/lazuli/ui/icons/', import.meta.url));
// ui/kit.js toneColor's names.
const TONES = new Set(['primary', 'secondary', 'default', 'tertiary', 'accent', 'accent2', 'onAccent', 'working', 'blocked', 'done', 'idle', 'unknown', 'success', 'warning', 'error', 'info']);
const OPENED = 1763568000000;
const NOW = OPENED + 5000;
const S = (over = {}) => ({ v: 1, at: OPENED + 1000, mode: 'off', active: false, reason: null, display: false, endsAt: null, closedLid: { wanted: false, status: 'off', blocked: null }, install: { sudo: true, failsafe: true }, ...over });
const at = { openedAt: OPENED, now: NOW };
const has = (key) => assert.ok(fragments.shell.en[key] && fragments.shell.ko[key], key);

test('names and the C9 host window', () => {
  assert.equal(MOD, 'herdr-caffeinate');
  assert.equal(STATE_KEY, 'herdr-caffeinate.state');
  assert.deepEqual(HOST, { mod: 'herdr-caffeinate', props: { view: 'host' }, kind: 'window', frame: 'none', key: 'herdr-caffeinate.host', width: 2, height: 2, at: { x: 0, y: 0 } });
  assert.equal('keep' in HOST, false);
});

test('invalid, stale and v: 2 states are starting, with no active styling', () => {
  const bad = [undefined, null, 'on', 7, [], {}, S({ v: 2 }), S({ v: '1' }), S({ v: undefined }), S({ at: OPENED - 1 }), S({ at: null }), S({ at: 'x' }),
    S({ mode: 'fast' }), S({ active: 'yes' }), S({ v: 2, mode: 'on', active: true, reason: 'user', closedLid: { status: 'engaged' } }),
    S({ at: OPENED - 60000, mode: 'on', active: true, reason: 'user' })];
  for (const s of bad) {
    const c = chip(s, at);
    assert.equal(c.status, 'starting', JSON.stringify(s));
    assert.equal(c.active, false);
    assert.notEqual(c.tone, 'accent');
    assert.deepEqual([c.icon, c.tone], [STATUS.starting.icon, STATUS.starting.tone]);
    assert.equal(c.lid, null);
    assert.equal(c.install, null);
    assert.equal(c.left, null);
    assert.equal(c.display, false);
  }
  assert.equal(usable(S({ at: OPENED }), OPENED), true);
  assert.equal(usable(S({ at: OPENED - 1 }), null), true, 'no host time: no staleness check');
  assert.equal(chip(S({ at: OPENED - 1 }), { now: NOW }).status, 'off');
});

test('each status maps to one icon and one tone; only accent ones are active', () => {
  const samples = {
    off: S(),
    waiting: S({ mode: 'agent', active: false }),
    on: S({ mode: 'on', active: true, reason: 'user' }),
    agent: S({ mode: 'agent', active: true, reason: 'agent' }),
    timer: S({ mode: 'timer', active: true, reason: 'timer', endsAt: NOW + 42 * 60000 }),
    trigger: S({ mode: 'on', active: true, reason: 'trigger' }),
    starting: S({ v: 2 }),
  };
  assert.deepEqual(Object.keys(STATUS).sort(), Object.keys(samples).sort());
  for (const [status, spec] of Object.entries(STATUS)) {
    assert.equal(typeof spec.icon, 'string');
    assert.ok(existsSync(`${ICONS}${spec.icon}.svg`), spec.icon);
    assert.ok(TONES.has(spec.tone), spec.tone);
    const c = chip(samples[status], at);
    assert.equal(c.status, status);
    assert.deepEqual([c.icon, c.tone], [spec.icon, spec.tone]);
    assert.equal(c.active, spec.tone === 'accent');
    assert.equal(c.active, ['on', 'agent', 'timer', 'trigger'].includes(status));
  }
  for (const [status, spec] of Object.entries(LID)) {
    assert.ok(existsSync(`${ICONS}${spec.icon}.svg`), spec.icon);
    assert.ok(TONES.has(spec.tone), spec.tone);
    const c = chip(S({ closedLid: { wanted: true, status, blocked: status === 'blocked' ? 'battery' : null } }), at);
    assert.deepEqual([c.lid.status, c.lid.icon, c.lid.tone], [status, spec.icon, spec.tone]);
  }
  assert.ok(existsSync(`${ICONS}coffee.svg`));
});

test('mode, display, timer and closed-lid details', () => {
  assert.equal(chip(S({ mode: 'timer', active: false, endsAt: NOW - 1 }), at).status, 'off', 'a timer that ended');
  assert.equal(chip(S({ mode: 'on', active: false }), at).status, 'off');
  assert.equal(chip(S({ mode: 'on', active: true, display: true }), at).display, true);
  assert.equal(chip(S({ mode: 'on', active: false, display: true }), at).display, false);
  assert.deepEqual(chip(S({ mode: 'timer', active: true, endsAt: NOW + 42 * 60000 }), at).left, { h: 0, m: 42 });
  assert.equal(chip(S({ mode: 'timer', active: true, endsAt: null }), at).left, null);
  assert.equal(chip(S({ mode: 'on', active: true, endsAt: NOW + 60000 }), at).left, null);
  assert.deepEqual(timeLeft(NOW + 65 * 60000, NOW), { h: 1, m: 5 });
  assert.deepEqual(timeLeft(NOW + 120 * 60000, NOW), { h: 2, m: 0 });
  assert.deepEqual(timeLeft(NOW + 30000, NOW), { h: 0, m: 1 });
  assert.deepEqual(timeLeft(NOW + 60001, NOW), { h: 0, m: 2 });
  assert.deepEqual(timeLeft(NOW - 5000, NOW), { h: 0, m: 1 });
  assert.equal(timeLeft('soon', NOW), null);
  assert.equal(chip(S(), at).lid, null);
  assert.equal(chip(S({ closedLid: null }), at).lid, null);
  assert.equal(chip(S({ closedLid: { status: 'weird' } }), at).lid, null);
  assert.deepEqual(chip(S({ closedLid: { status: 'external', blocked: null } }), at).lid, { status: 'external', ...LID.external, blocked: null });
  assert.equal(chip(S({ closedLid: { status: 'blocked', blocked: 'thermal' } }), at).lid.blocked, 'thermal');
  assert.equal(chip(S({ closedLid: { status: 'blocked', blocked: null } }), at).lid.blocked, 'unknown');
  assert.equal(chip(S({ closedLid: { status: 'engaged', blocked: 'ac' } }), at).lid.blocked, null);
  assert.deepEqual(chip(S({ install: { sudo: false, failsafe: true } }), at).install, { sudo: false, failsafe: true });
  assert.equal(chip(S({ install: { sudo: 'yes', failsafe: true } }), at).install, null);
  const frozen = Object.freeze(S({ mode: 'on', active: true }));
  chip(frozen, at);
  assert.equal(frozen.mode, 'on');
});

test('palette commands follow the state', () => {
  const base = ['menu', 'toggle', 'mode:on', 'mode:agent', 'mode:off', 'timer:15', 'timer:60', 'timer:120', 'display:toggle', 'closed-lid:toggle'];
  assert.deepEqual(paletteCommands(chip(null, at)), base);
  assert.deepEqual(paletteCommands(chip(S(), at)), [...base, 'uninstall']);
  assert.deepEqual(paletteCommands(chip(S({ install: { sudo: false, failsafe: false } }), at)), [...base, 'install']);
  assert.deepEqual(paletteCommands(chip(S({ install: { sudo: true, failsafe: false } }), at)), [...base, 'install', 'uninstall']);
  assert.deepEqual(paletteCommands(chip(S({ install: null }), at)), base);
  assert.ok(paletteCommands(chip(S({ mode: 'timer', active: true, endsAt: NOW + 60000 }), at)).includes('timer:cancel'));
  assert.ok(!paletteCommands(chip(S({ mode: 'on', active: true }), at)).includes('timer:cancel'));
  assert.equal(commandKey('closed-lid:toggle'), 'closed-lid.toggle');
  assert.equal(commandKey('timer:15'), 'timer.15');
});

test('every text the chip and the palette use exists in both languages', () => {
  for (const status of Object.keys(STATUS)) {
    if (status !== 'starting' && status !== 'off') has(`shell.caffeinate.label.${status}`);
    has(`shell.caffeinate.tip.${status}`);
  }
  for (const key of ['label.timer', 'tip.timerOpen', 'tip.display', 'tip.open', 'left.m', 'left.h', 'left.hm']) has(`shell.caffeinate.${key}`);
  for (const status of Object.keys(LID)) has(`shell.caffeinate.tip.lid.${status}`);
  for (const reason of BLOCKED) has(`shell.caffeinate.blocked.${reason}`);
  for (const cmd of COMMANDS) {
    has(`shell.caffeinate.cmd.${commandKey(cmd)}`);
    assert.match(fragments.shell.en[`shell.caffeinate.cmd.${commandKey(cmd)}`], /^Caffeinate: /);
    assert.match(fragments.shell.ko[`shell.caffeinate.cmd.${commandKey(cmd)}`], /^Caffeinate: /);
  }
});
