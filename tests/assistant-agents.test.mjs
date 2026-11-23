import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PERMISSION_TIMEOUT_MS, AGENTS, AGENT_IDS, agentOf, isProfileName, agentArgv, checkArgv, stateDbPath, profilesDir,
  steerReply, parseSlash, routeText, menuCommands,
} from '../mods/lazuli/core/assistant-agents.js';

test('registry: hermes and the planned nod', () => {
  assert.equal(PERMISSION_TIMEOUT_MS, 60000);
  assert.deepEqual([...AGENT_IDS], ['hermes', 'nod']);
  assert.equal(agentOf('hermes').planned, false);
  assert.equal(agentOf('nod').planned, true);
  assert.equal(agentOf('x'), null);
  assert.equal(agentOf('toString'), null);
  assert.deepEqual([...AGENTS.hermes.buttonOptions], ['allow_once', 'allow_always', 'deny']);
  assert.deepEqual({ ...AGENTS.hermes.quickAnswers }, { allow: 'allow_once', deny: 'deny' });
  assert.deepEqual([...AGENTS.hermes.resyncCommands], ['reset', 'compact']);
  assert.ok(Object.isFrozen(AGENTS.hermes) && Object.isFrozen(AGENTS.hermes.steerReplies));
});

test('agent argv always carries -p <profile>, default included', () => {
  assert.deepEqual(agentArgv({ bin: '/opt/bin/hermes', profile: 'default' }), ['/opt/bin/hermes', '-p', 'default', 'acp']);
  assert.deepEqual(agentArgv({ bin: '/opt/bin/hermes', profile: 'coder' }), ['/opt/bin/hermes', '-p', 'coder', 'acp']);
  assert.deepEqual(
    agentArgv({ bin: '/opt/bin/hermes', profile: 'coder', debugAgent: ['/usr/local/bin/node', '/r/tests/fixtures/fake-acp-agent.mjs'] }),
    ['/usr/local/bin/node', '/r/tests/fixtures/fake-acp-agent.mjs', '-p', 'coder', 'acp'],
  );
  for (const profile of ['default', 'a', 'backend-engineer', 'x_1']) {
    for (const o of [{ bin: '/h' }, { debugAgent: ['/n', '/f.mjs'] }]) {
      const argv = agentArgv({ ...o, profile });
      assert.equal(argv[argv.indexOf('-p') + 1], profile);
      assert.equal(argv.at(-1), 'acp');
    }
  }
  // an empty or malformed debugAgent falls back to the Hermes path
  assert.deepEqual(agentArgv({ bin: '/h', profile: 'default', debugAgent: [] }), ['/h', '-p', 'default', 'acp']);
  assert.deepEqual(agentArgv({ bin: '/h', profile: 'default', debugAgent: ['/n', 3] }), ['/h', '-p', 'default', 'acp']);
  assert.equal(agentArgv({ bin: '/h', profile: 'Bad' }), null);
  assert.equal(agentArgv({ bin: '/h', profile: '../x' }), null);
  assert.equal(agentArgv({ bin: '/h' }), null);
  assert.equal(agentArgv({ profile: 'default' }), null);
  assert.deepEqual(checkArgv({ bin: '/h' }), ['/h', 'acp', '--check']);
  assert.deepEqual(checkArgv({ bin: '/h', debugAgent: ['/n', '/f.mjs'] }), ['/n', '/f.mjs', 'acp', '--check']);
  assert.equal(checkArgv({}), null);
});

test('profile names follow Hermes and map to their state.db', () => {
  for (const ok of ['default', 'a', '0', 'a-b_c', 'a'.repeat(64)]) assert.equal(isProfileName(ok), true, ok);
  for (const bad of ['', 'A', '-a', '_a', 'a b', 'a/b', '..', 'a'.repeat(65), 'no:xdist', null, 3]) assert.equal(isProfileName(bad), false, String(bad));
  assert.equal(stateDbPath('/Users/u', 'default'), '/Users/u/.hermes/state.db');
  assert.equal(stateDbPath('/Users/u/', 'coder'), '/Users/u/.hermes/profiles/coder/state.db');
  assert.equal(stateDbPath('/Users/u', 'Bad'), null);
  assert.equal(stateDbPath('', 'default'), null);
  assert.equal(profilesDir('/Users/u'), '/Users/u/.hermes/profiles');
});

test('steer answers are the exact Hermes texts, matched anchored', () => {
  assert.deepEqual(steerReply('\u23E9 Steer queued for the active turn: go left'), { code: 'steer-ack', vars: { preview: 'go left' } });
  assert.deepEqual(steerReply('\u23E9 Steer queued for the active turn: a\nb...'), { code: 'steer-ack', vars: { preview: 'a\nb...' } });
  assert.deepEqual(steerReply('No active turn \u2014 queued for the next turn. (2 queued)'), { code: 'steer-queued', vars: { depth: 2 } });
  assert.deepEqual(steerReply('\u26A0\uFE0F Steer failed: boom'), { code: 'steer-failed', vars: { detail: 'boom' } });
  assert.deepEqual(steerReply('Usage: /steer <guidance>'), { code: 'steer-failed', vars: { detail: 'Usage: /steer <guidance>' } });
  for (const no of [
    'Queued for the next turn. (1 queued)', // a plain prompt or /queue queued by Hermes
    'Sure. \u23E9 Steer queued for the active turn: x', // not at the start
    ' \u23E9 Steer queued for the active turn: x',
    'Steer queued for the active turn: x',
    'No active turn \u2014 queued for the next turn. (1 queued) and more', // not the whole chunk
    'No active turn - queued for the next turn. (1 queued)', // hyphen, not the em dash
    '\u26A0 Steer failed: x', // without the variation selector
    'Usage: /steer <guidance> please',
    '',
  ]) assert.equal(steerReply(no), null, no);
  assert.equal(steerReply('\u23E9 Steer queued for the active turn: x', 'nod'), null);
  assert.equal(steerReply(null), null);
});

test('slash parsing and composer routes', () => {
  assert.deepEqual(parseSlash('  /Help  '), { name: 'help', args: '' });
  assert.deepEqual(parseSlash('//model  openai:gpt-5 '), { name: 'model', args: 'openai:gpt-5' });
  assert.deepEqual(parseSlash('/steer go\nleft'), { name: 'steer', args: 'go\nleft' });
  assert.equal(parseSlash('hello /help'), null);
  assert.equal(parseSlash(5), null);
  assert.deepEqual(routeText('/model openai-codex:gpt-5.5'), { route: 'model', model: 'openai-codex:gpt-5.5' });
  assert.deepEqual(routeText('/model'), { route: 'command', name: 'model', resync: false });
  assert.deepEqual(routeText('/queue later please'), { route: 'queue', text: 'later please' });
  assert.deepEqual(routeText('/steer go left'), { route: 'steer', text: '/steer go left' });
  assert.deepEqual(routeText('/reset'), { route: 'command', name: 'reset', resync: true });
  assert.deepEqual(routeText('/COMPACT'), { route: 'command', name: 'compact', resync: true });
  assert.deepEqual(routeText('/help'), { route: 'command', name: 'help', resync: false });
  assert.deepEqual(routeText('/version'), { route: 'command', name: 'version', resync: false });
  assert.deepEqual(routeText('/deploy now'), { route: 'prompt' });
  assert.deepEqual(routeText('hello'), { route: 'prompt' });
  assert.deepEqual(routeText('/help', 'nod'), { route: 'prompt' });
  const menu = menuCommands([{ name: 'help' }, { name: 'steer' }, { name: 'queue' }, { name: 'model' }, { x: 1 }]);
  assert.deepEqual(menu.map((c) => c.name), ['help', 'model']);
  assert.deepEqual(menuCommands(null), []);
});
