import { isEntrypoint } from "./entrypoint.mjs";
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './problems.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const banner = { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" };

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Discovers every generated artifact from its source, so adding or removing a
// plugin server or grader doesn't require editing this script.
export async function discoverBundles(directory = root) {
  const bundles = [];
  for (const plugin of (await entries(resolve(directory, 'plugins'))).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const source = `plugins/${plugin.name}/src/server.ts`;
    if (!(await entries(resolve(directory, 'plugins', plugin.name, 'src'))).some(entry => entry.isFile() && entry.name === 'server.ts')) continue;
    const manifest = JSON.parse(await readFile(resolve(directory, 'plugins', plugin.name, 'plugin.json'), 'utf8'));
    bundles.push({
      entry: source,
      output: `plugins/${plugin.name}/dist/server.mjs`,
      label: `the bundled ${plugin.name} MCP server`,
      define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
    });
  }
  for (const grader of (await entries(resolve(directory, 'evals/graders/src'))).filter(entry => entry.isFile() && entry.name.endsWith('.mjs')).sort((a, b) => a.name.localeCompare(b.name))) {
    bundles.push({
      entry: `evals/graders/src/${grader.name}`,
      output: `evals/graders/dist/${grader.name}`,
      label: `the bundled ${basename(grader.name, '.mjs')} grader`,
      define: {},
    });
  }
  return bundles;
}

async function notices(directory, label, metafile) {
  const packagePaths = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.replaceAll('\\', '/').match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)/);
    if (match) packagePaths.add(match[1]);
  }
  let text = `Third-party licenses for ${label}.\n`;
  for (const path of [...packagePaths].sort()) {
    const dir = resolve(directory, path);
    const pkg = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8'));
    const licenses = (await readdir(dir)).filter(name => /^licen[sc]e(?:[.-]|$)/i.test(name)).sort();
    if (!licenses.length) throw new Error(`No license text found for bundled package ${pkg.name}`);
    text += `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version} (${pkg.license ?? 'see license'})\n`;
    for (const license of licenses) text += `${await readFile(resolve(dir, license), 'utf8')}\n`;
  }
  return { text, packages: packagePaths.size };
}

// esbuild names each bundled module by its path from the repository. When
// node_modules lives elsewhere (a workspace root, a link, or a shared install),
// those paths would differ per machine, so they're rewritten to start at
// node_modules/. Only path comments and module keys change, never code.
export function portable(text) {
  return text
    .replace(/^(\s*\/\/ )[^\n]*?(?<![^/\s])(node_modules\/[^\n]*)$/gm, '$1$2')
    .replace(/^(\s*")[^"\n]*?(?<![^/"])(node_modules\/[^"\n]*"\()/gm, '$1$2');
}

export async function generate(directory = root) {
  const files = new Map();
  const groups = new Map();
  for (const bundle of await discoverBundles(directory)) {
    const output = resolve(directory, bundle.output);
    const result = await build({
      absWorkingDir: directory,
      entryPoints: [bundle.entry],
      outfile: output,
      platform: 'node', format: 'esm', target: 'node22',
      bundle: true, write: false, metafile: true, legalComments: 'inline',
      define: bundle.define,
      banner,
    });
    files.set(output, portable(result.outputFiles[0].text));
    const noticesPath = resolve(dirname(output), 'THIRD_PARTY_NOTICES.txt');
    const group = groups.get(noticesPath) ?? [];
    group.push({ label: bundle.label, metafile: result.metafile });
    groups.set(noticesPath, group);
  }
  for (const [path, group] of groups) {
    const parts = [];
    for (const { label, metafile } of group) {
      const notice = await notices(directory, label, metafile);
      if (notice.packages) parts.push(notice.text);
    }
    if (parts.length) files.set(path, parts.join('\n'));
  }
  return files;
}

// Every file in a generated directory: plugins/<name>/dist/ and evals/graders/dist/.
export async function generatedFiles(directory = root) {
  const found = [];
  async function walk(path) {
    for (const entry of await entries(path)) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else found.push(child);
    }
  }
  for (const plugin of (await entries(resolve(directory, 'plugins'))).filter(entry => entry.isDirectory())) {
    await walk(resolve(directory, 'plugins', plugin.name, 'dist'));
  }
  await walk(resolve(directory, 'evals/graders/dist'));
  return found;
}

const normalize = text => text.replaceAll('\r\n', '\n');
const label = (directory, path) => relative(directory, path).split(sep).join('/');

// Writes every generated artifact that changed and deletes the ones whose
// source is gone. Returns the repository paths it deleted.
export async function writeGenerated(directory = root) {
  const files = await generate(directory);
  for (const [path, contents] of files) {
    let current;
    try { current = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current !== undefined && normalize(current) === normalize(contents)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const removed = [];
  for (const path of await generatedFiles(directory)) {
    if (files.has(path)) continue;
    await rm(path, { force: true });
    removed.push(label(directory, path));
  }
  return { count: files.size, removed };
}

export async function checkGenerated(directory = root) {
  const files = await generate(directory);
  for (const [path, contents] of files) {
    let current;
    try { current = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Missing generated artifact: ${label(directory, path)}. Run npm run build.`); throw error; }
    if (normalize(current) !== normalize(contents)) throw new Error(`Stale generated artifact: ${label(directory, path)}. Run npm run build.`);
  }
  const orphaned = (await generatedFiles(directory)).filter(path => !files.has(path));
  if (orphaned.length) {
    throw new Error(`Orphaned generated artifact${orphaned.length === 1 ? '' : 's'}: ${orphaned.map(path => label(directory, path)).join(', ')}. `
      + 'Nothing builds these anymore because their source is gone. Run npm run build to delete them.');
  }
  return files.size;
}

async function main() {
  if (process.argv.includes('--check')) {
    console.log(`${await checkGenerated()} generated artifacts are current.`);
    return;
  }
  const { count, removed } = await writeGenerated();
  for (const path of removed) console.log(`Deleted ${path}; its source is gone.`);
  console.log(`Built ${count} generated artifacts.`);
}

if (isEntrypoint(import.meta.url)) await runCli(main);
