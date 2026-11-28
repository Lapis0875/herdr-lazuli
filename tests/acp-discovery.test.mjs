import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeSync } from 'node:fs';
import { reserve } from '../mods/lazuli/bin/lib/acp-discovery.mjs';

const BRIDGE = fileURLToPath(new URL('../mods/lazuli/bin/acp-bridge.mjs', import.meta.url));
const LOCK = new URL('../mods/lazuli/bin/lib/acp-discovery.mjs', import.meta.url).href;
const node = (args) => new Promise((resolve) => {
  execFile(process.execPath, args, { timeout: 2000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
});

test('profile reservation excludes another OS process, then releases on holder exit without replacing the inode', { timeout: 6000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-reservation-'));
  const current = join(dir, 'v2', 'default.json');
  const legacy = join(dir, 'default.json');
  const lock = `${current}.lock`;
  const publication = JSON.stringify({ version: 1, pid: 100, error: { code: 'init-failed', detail: 'new receipt' } });
  const helper = `
    import { reserve } from ${JSON.stringify(LOCK)};
    import { writeFileSync, renameSync } from 'node:fs';
    const [lock, path, publication] = process.argv.slice(1);
    if (reserve(lock) === null) process.exit(75);
    process.stdin.once('data', () => {
      writeFileSync(path + '.tmp', publication, {mode: 0o600}); renameSync(path + '.tmp', path);
      process.stdout.write('published\\n');
    });
    process.stdout.write('held\\n');
  `;
  await mkdir(join(dir, 'v2'));
  const holder = spawn(process.execPath, ['--input-type=module', '-e', helper, lock, current, publication]);
  const held = once(holder.stdout, 'data');
  const exited = once(holder, 'exit');
  try {
    assert.equal(String((await held)[0]), 'held\n');
    const { ino } = await stat(lock);
    const inspect = [BRIDGE, '--inspect-discovery', current, legacy];
    assert.deepEqual(JSON.parse((await node(inspect)).stdout), { current: null, legacy: null });
    const contender = [BRIDGE, '--profile', 'default', '--cwd', dir, '--discovery', current, '--log', join(dir, 'log'),
      '--herdr-pid', String(process.pid), '--previous', 'absent', '--legacy', legacy, '--legacy-previous', 'absent', '--agent', '--', process.execPath, '-e', 'process.exit(99)'];
    const busy = await node(contender);
    assert.equal(busy.error?.code, 1);
    assert.match(busy.stderr, /holds the profile reservation/);
    const published = once(holder.stdout, 'data');
    holder.stdin.write('publish');
    assert.equal(String((await published)[0]), 'published\n');
    holder.stdin.end();
    assert.deepEqual(await exited, [0, null]);

    // Same stale snapshot, but now the competing publication happened and its author already exited.
    const stale = await node(contender);
    assert.equal(stale.error?.code, 1);
    assert.match(stale.stderr, /discovery changed before reservation/);
    assert.equal(await readFile(current, 'utf8'), publication);
    const acquired = reserve(lock);
    assert.notEqual(acquired, null);
    closeSync(acquired);
    assert.equal((await stat(lock)).ino, ino);
  } finally {
    holder.stdin.end();
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery inspection distinguishes ENOENT from directory and dangling symlink', { timeout: 5000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-inspection-'));
  try {
    const current = join(dir, 'current');
    const legacy = join(dir, 'legacy');
    const inspect = [BRIDGE, '--inspect-discovery', current, legacy];
    const absent = await node(inspect);
    assert.equal(absent.error, null);
    assert.deepEqual(JSON.parse(absent.stdout), { current: null, legacy: null });
    await symlink(join(dir, 'missing'), legacy);
    const symlinkResult = await node(inspect);
    assert.equal(symlinkResult.error?.code, 1);
    assert.equal(symlinkResult.stdout, '');
    await mkdir(current);
    const directoryResult = await node(inspect);
    assert.equal(directoryResult.error?.code, 1);
    assert.match(directoryResult.stderr, /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
