import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notices, portable } from './build.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const plugin = 'session-todos';
const output = resolve(root, `plugins/${plugin}/com.github.copilot/extensions/${plugin}`);
const check = process.argv.includes('--check');
const files = new Map();
if (!existsSync(resolve(root, `plugins/${plugin}/src/extension.mjs`))) process.exit(0);
const result = await build({
  absWorkingDir: root,
  entryPoints: [`plugins/${plugin}/src/extension.mjs`],
  outfile: resolve(output, 'extension.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@github/copilot-sdk', '@github/copilot-sdk/*'],
  write: false,
  metafile: true,
  legalComments: 'inline',
});
files.set('extension.mjs', portable(result.outputFiles[0].text));
const uiMetadata = await build({
  absWorkingDir: root,
  stdin: {
    contents: `import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@rwoll/canvas-kit/styles.css';
import App from './canvases/session-todos/App.tsx';
createRoot(document.getElementById('root')).render(createElement(App));`,
    resolveDir: root,
    sourcefile: 'session-todos-ui.ts',
  },
  outfile: resolve(output, 'ui/app.js'),
  bundle: true, platform: 'browser', format: 'esm', minify: true,
  write: false, metafile: true,
});
const notice = await notices(root, 'Session Todos', {
  inputs: { ...result.metafile.inputs, ...uiMetadata.metafile.inputs },
});
files.set('THIRD_PARTY_NOTICES.txt', `${notice.text.trimEnd()}\n`);
for (const file of uiMetadata.outputFiles) {
  files.set(file.path.slice(output.length + 1).replaceAll('\\', '/'), file.contents);
}
files.set('ui/session-todos.html', `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session Todos</title><link rel="icon" href="data:,"><link rel="stylesheet" href="./app.css"></head>
<body><div id="root"></div><script type="module" src="./app.js"></script></body></html>
`);
for (const [path, contents] of files) {
  const target = resolve(output, path);
  if (check) {
    let existing;
    try { existing = await readFile(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Missing canvas build: ${path}. Run npm run build.`);
    }
    if (!existing.equals(Buffer.from(contents))) throw new Error(`Stale canvas build: ${path}. Run npm run build.`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}
for (const entry of await readdir(output, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = resolve(entry.parentPath, entry.name);
  const relative = path.slice(output.length + 1).replaceAll('\\', '/');
  if (files.has(relative)) continue;
  if (check) throw new Error(`Orphaned canvas build: ${relative}. Run npm run build.`);
  await rm(path);
}
console.log(`Session Todos: ${files.size} generated files ${check ? 'verified' : 'built'}.`);
