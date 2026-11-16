import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
let files;
try {
  files = (await readdir(new URL('../../canvases/', import.meta.url), { recursive: true }))
    .filter(path => path.endsWith('.test.ts')).map(path => `canvases/${path}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  files = [];
}
if (files.length) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  console.log('No canvas tests: no canvases remain in this marketplace.');
}
