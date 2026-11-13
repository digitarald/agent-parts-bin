import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { typeScriptSources } from '../scripts/typecheck.mjs';

test('plugin type checking discovers native TypeScript hooks without dependency sources', async t => {
  const root = await mkdtemp(join(tmpdir(), 'commit-attribution-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, 'plugins', 'fixture', 'scripts');
  await mkdir(join(scripts, 'node_modules'), { recursive: true });
  await writeFile(join(scripts, 'hook.mts'), 'export const value: string = "hook";\n');
  await writeFile(join(scripts, 'server.ts'), 'export const value: string = "server";\n');
  await writeFile(join(scripts, 'node_modules', 'dependency.mts'), '');
  assert.deepEqual((await typeScriptSources(root)).sort(), [
    join('fixture', 'scripts', 'hook.mts'), join('fixture', 'scripts', 'server.ts'),
  ]);
});
