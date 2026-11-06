import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, delimiter, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, readFileSync } from 'node:fs';
import { root as projectRoot, runtimeBridge, runtimeEnvironment, evalParams, vallyCliPath } from '../scripts/evals.mjs';
import { parseYaml } from '../scripts/catalog.mjs';
import { spawnSync } from 'node:child_process';
import { packageVersion, runtimeProcessEnvironment } from '../scripts/eval-runtime.js';

test('direct Node execution gets the pinned validator and a normalized executable path', () => {
  const env = runtimeEnvironment({ Path: '/existing/bin', KEEP: 'yes' });
  assert.equal(env.KEEP, 'yes');
  assert.equal(Object.keys(env).filter(key => key.toLowerCase() === 'path').length, 1);
  assert.equal(env.PATH.split(delimiter)[0], resolve(projectRoot, 'node_modules/.bin'));
  assert.ok(env.PATH.endsWith('/existing/bin'));
  // The customization-authoring example passes the pinned Vally CLI as a param.
  if ('MARKETPLACE_VALLY_CLI' in evalParams) {
    assert.equal(evalParams.MARKETPLACE_VALLY_CLI, vallyCliPath);
    assert.ok(isAbsolute(evalParams.MARKETPLACE_VALLY_CLI));
  }
});

test('the eval launches the actual shipped MCP bundle independently of the process cwd', { skip: !existsSync(resolve(projectRoot, 'plugins/json-configuration')) }, async () => {
  const jsonMcpServerPath = evalParams.JSON_MCP_SERVER;
  const spec = parseYaml(await readFile(resolve(projectRoot, 'evals/json-configuration/eval.yaml'), 'utf8'), 'json eval');
  assert.deepEqual(spec.agent_environment.mcpServers['json-configuration'].args, ['${JSON_MCP_SERVER}']);
  assert.ok(isAbsolute(jsonMcpServerPath));
  const dir = await mkdtemp(join(tmpdir(), 'marketplace unrelated cwd '));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [jsonMcpServerPath],
    cwd: dir, env: getDefaultEnvironment(), stderr: 'inherit'
  });
  const client = new Client({ name: 'runtime-path-test', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: 10000 });
    const result = await client.callTool({
      name: 'get_json_value', arguments: { json: '{"value":42}', pointer: '/value' }
    });
    assert.deepEqual(result.structuredContent, { found: true, value: 42 });
  } finally {
    try { await client.close(); }
    finally {
      try { await transport.close(); }
      finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
});

test('the runtime bridge runs the pinned Copilot CLI, not a newer auto-updated copy', () => {
  assert.equal(runtimeProcessEnvironment({}).COPILOT_AUTO_UPDATE, 'false');
  assert.equal(runtimeProcessEnvironment({ COPILOT_AUTO_UPDATE: 'true' }).COPILOT_AUTO_UPDATE, 'true');
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageVersion(), manifest.devDependencies['@github/copilot']);
  const env = { ...process.env };
  delete env.COPILOT_AUTO_UPDATE;
  const result = spawnSync(process.execPath, [runtimeBridge, '--version'], { encoding: 'utf8', env, timeout: 60_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, new RegExp(`Pinned @github/copilot package: ${packageVersion().replaceAll('.', '\\.')}`));
  assert.match(result.stdout, new RegExp(`Copilot CLI ${packageVersion().replaceAll('.', '\\.')}\\b`));
});
