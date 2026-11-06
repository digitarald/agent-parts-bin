import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test as baseTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { missing } from '../scripts/examples.mjs';

// Example-only tests: skip every test here when the example's files are gone.
const skip = missing('plugins/json-configuration/dist/server.mjs');
const test = skip ? (name) => baseTest(name, { skip }) : baseTest;
const { MAX_JSON_LENGTH, TOOL_NAMES } = skip ? {} : await import('../plugins/json-configuration/dist/server.mjs');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'plugins', 'json-configuration', 'dist', 'server.mjs');

function assertStructured(result, expected) {
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, expected);
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(expected) }]);
}

test('the relocated standalone bundle implements the real stdio MCP protocol', { timeout: 45_000 }, async t => {
  const directory = await mkdtemp(join(root, '.mcp-protocol isolated # '));
  const filename = 'relocated server # %.mjs';
  const relocatedBundle = join(directory, filename);
  const client = new Client({ name: 'marketplace-protocol-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Keep fixtures in this checkout, but deny access to its ancestor node_modules and all writes.
    args: ['--permission', `--allow-fs-read=${directory}`, relocatedBundle],
    cwd: directory,
    env: { NODE_PATH: '', NODE_OPTIONS: '' },
    stderr: 'pipe'
  });
  const errors = [];
  const stderr = [];
  const closed = Promise.withResolvers();
  transport.onclose = closed.resolve;
  transport.stderr.on('data', chunk => stderr.push(chunk.toString()));
  client.onerror = error => errors.push(error.message);

  t.after(async () => {
    try {
      await client.close();
    } finally {
      try {
        await transport.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  await copyFile(bundle, relocatedBundle);
  assert.deepEqual(await readdir(directory), [filename]);
  await client.connect(transport, { timeout: 10_000 });
  assert.ok(transport.pid > 0, 'the SDK must launch an actual child process');

  await t.test('initialization and listing expose the complete annotated tool contract', async () => {
    const manifest = JSON.parse(await readFile(new URL('../plugins/json-configuration/plugin.json', import.meta.url), 'utf8'));
    assert.deepEqual(client.getServerVersion(), { name: 'json-configuration', version: manifest.version });
    assert.ok(client.getServerCapabilities().tools);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      });
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.properties.json.type, 'string');
      assert.equal(tool.inputSchema.properties.json.maxLength, MAX_JSON_LENGTH);
      assert.match(tool.description, /1,048,576/u);
      assert.match(tool.description, /finite JavaScript number/u);
      assert.ok(tool.inputSchema.required.includes('json'));
      if (tool.name === 'get_json_value') {
        assert.equal(tool.inputSchema.properties.pointer.type, 'string');
        assert.ok(tool.inputSchema.required.includes('pointer'));
      }
    }
  });

  await t.test('validate_json accepts every JSON type through actual tool calls', async () => {
    for (const [json, type] of [
      ['{"a":1}', 'object'], ['[0,null]', 'array'], ['"text"', 'string'],
      ['1.5', 'number'], ['false', 'boolean'], ['null', 'null']
    ]) {
      assertStructured(await client.callTool({
        name: 'validate_json', arguments: { json }
      }), { valid: true, type });
    }
  });

  await t.test('overflowing numbers produce INVALID_JSON instead of silently becoming null', async () => {
    const error = {
      code: 'INVALID_JSON',
      message: 'Unsupported numeric range: JSON numbers must decode to finite JavaScript numbers.'
    };
    for (const json of [
      '1e400', '-1e400', '1.7976931348623159e308', '9'.repeat(400),
      '[0,null,1e400]', '{"outer":{"values":[false,null,-1e400]}}',
      '{"__proto__":{"value":1e400}}', '{"constructor":1e400}',
      '{"private":"SYNTHETIC_NUMBER_INPUT","safe":null,"overflow":1e400}'
    ]) {
      assertStructured(await client.callTool({
        name: 'validate_json', arguments: { json }
      }), { valid: false, error });
      for (const pointer of ['', '/safe']) {
        const result = await client.callTool({
          name: 'get_json_value', arguments: { json, pointer }
        });
        assertStructured(result, { found: false, error });
        assert.ok(!JSON.stringify(result).includes('SYNTHETIC_NUMBER_INPUT'));
      }
    }
  });

  await t.test('finite boundaries, scalars, and real nulls survive protocol serialization', async () => {
    for (const [json, value] of [
      ['1.7976931348623157e308', Number.MAX_VALUE],
      ['-1.7976931348623157e308', -Number.MAX_VALUE],
      ['5e-324', Number.MIN_VALUE], ['1e-400', 0], ['-42.5', -42.5],
      ['null', null], ['true', true], ['"1e400"', '1e400']
    ]) {
      assertStructured(await client.callTool({
        name: 'validate_json', arguments: { json }
      }), { valid: true, type: value === null ? 'null' : typeof value });
      assertStructured(await client.callTool({
        name: 'get_json_value', arguments: { json, pointer: '' }
      }), { found: true, value });
    }
    const json = '{"safe":null,"nested":[1.5,null],"1e400":"-1e400"}';
    assertStructured(await client.callTool({
      name: 'validate_json', arguments: { json }
    }), { valid: true, type: 'object' });
    for (const [pointer, value] of [['/safe', null], ['/nested/1', null], ['/1e400', '-1e400']]) {
      assertStructured(await client.callTool({
        name: 'get_json_value', arguments: { json, pointer }
      }), { found: true, value });
    }
  });

  await t.test('get_json_value returns root, nested, escaped, and reserved-name data', async () => {
    const json = '{"a/b":{"~key":[null,false,0,""]},"__proto__":{"own":42},'
      + '"constructor":"own-constructor"}';
    for (const [pointer, value] of [
      ['', JSON.parse(json)], ['/a~1b/~0key/0', null], ['/a~1b/~0key/1', false],
      ['/a~1b/~0key/2', 0], ['/a~1b/~0key/3', ''], ['/__proto__/own', 42],
      ['/constructor', 'own-constructor']
    ]) {
      const params = { name: 'get_json_value', arguments: { json, pointer } };
      const first = await client.callTool(params);
      assertStructured(first, { found: true, value });
      assert.deepEqual(await client.callTool(params), first);
    }
    assertStructured(await client.callTool({
      name: 'get_json_value', arguments: { json: 'null', pointer: '' }
    }), { found: true, value: null });
  });

  await t.test('domain errors stay structured, distinguish absence, and never echo input', async () => {
    const secret = 'SYNTHETIC_INPUT_MUST_NOT_BE_ECHOED';
    for (const name of TOOL_NAMES) {
      const result = await client.callTool({
        name, arguments: { json: `{"private":"${secret}",}`, ...(name === 'get_json_value' ? { pointer: '' } : {}) }
      });
      assertStructured(result, {
        [name === 'validate_json' ? 'valid' : 'found']: false,
        error: { code: 'INVALID_JSON', message: 'JSON input is not valid JSON.' }
      });
      assert.ok(!JSON.stringify(result).includes(secret));
    }
    for (const [json, pointer, code] of [
      ['{}', '/missing', 'NOT_FOUND'],
      ['{}', '/constructor', 'NOT_FOUND'],
      ['{}', '/__proto__', 'NOT_FOUND'],
      ['null', '/value', 'NOT_FOUND'],
      ['[1]', '/1', 'NOT_FOUND'],
      ['{}', '#/value', 'INVALID_POINTER'],
      ['{}', '/~2', 'INVALID_POINTER'],
      ['[1]', '/01', 'INVALID_POINTER'],
      ['[1]', '/-', 'INVALID_POINTER']
    ]) {
      const result = await client.callTool({ name: 'get_json_value', arguments: { json, pointer } });
      assert.equal(result.structuredContent.found, false);
      assert.equal(result.structuredContent.error.code, code);
      assert.equal(typeof result.structuredContent.error.message, 'string');
      assertStructured(result, result.structuredContent);
    }
  });

  await t.test('Zod rejects invalid arguments and unknown tools without breaking the connection', async () => {
    for (const [name, args] of [
      ['validate_json', {}],
      ['validate_json', { json: { private: 'SYNTHETIC_SCHEMA_INPUT' } }],
      ['get_json_value', { json: '{}' }],
      ['get_json_value', { json: '{}', pointer: 42 }],
      ['unknown_tool', {}]
    ]) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.ok(result.content.some(item => item.type === 'text' && item.text.length > 0));
      assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SCHEMA_INPUT'));
    }
    assertStructured(await client.callTool({
      name: 'validate_json', arguments: { json: '{}' }
    }), { valid: true, type: 'object' });
  });

  await t.test('the advertised input bound is enforced at the MCP boundary', async () => {
    const json = `0${' '.repeat(MAX_JSON_LENGTH - 1)}`;
    assert.equal(json.length, MAX_JSON_LENGTH);
    assertStructured(await client.callTool({
      name: 'validate_json', arguments: { json }
    }), { valid: true, type: 'number' });
    assertStructured(await client.callTool({
      name: 'get_json_value', arguments: { json, pointer: '' }
    }), { found: true, value: 0 });
    for (const name of TOOL_NAMES) {
      const result = await client.callTool({
        name, arguments: { json: `${json} `, ...(name === 'get_json_value' ? { pointer: '' } : {}) }
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /maximum of 1,048,576 characters/u);
      assert.ok(result.content[0].text.length < 2_000, 'schema errors must not contain the oversized input');
    }
  });

  await client.close();
  await closed.promise;
  assert.equal(transport.pid, null, 'the child process must be closed before removing its directory');
  assert.deepEqual(errors, [], 'stdout must contain only valid MCP messages');
  assert.equal(stderr.join(''), '', 'successful startup and calls must not log errors');
  assert.deepEqual(await readdir(directory), [filename], 'the server must not persist anything');
});

test('startup failures report the actual reason on stderr and exit nonzero', { timeout: 10_000 }, async t => {
  const reason = 'synthetic MCP transport startup failure';
  const preload = `
    const originalOn = process.stdin.on;
    process.stdin.on = function (event, ...args) {
      if (event === 'data') throw new Error(${JSON.stringify(reason)});
      return originalOn.call(this, event, ...args);
    };
  `;
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`, bundle
  ], {
    cwd: root,
    env: getDefaultEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: t.signal
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk.toString()));
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const [code, signal] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.equal(stdout.join(''), '');
  assert.match(stderr.join(''), /Failed to start the JSON configuration MCP server/u);
  assert.ok(stderr.join('').includes(reason), 'the original failure reason must be logged');
});

test('the bundle starts when launched through a symlinked directory', { timeout: 30_000 }, async t => {
  const real = await mkdtemp(join(tmpdir(), 'mcp-real-'));
  const linked = `${real}-link`;
  await copyFile(bundle, join(real, 'server.mjs'));
  // A junction needs no elevation on Windows; macOS temp paths are already symlinked (/var -> /private/var).
  await symlink(real, linked, 'junction');
  const client = new Client({ name: 'marketplace-symlink-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(linked, 'server.mjs')],
    cwd: linked,
    env: { NODE_PATH: '', NODE_OPTIONS: '' },
    stderr: 'pipe'
  });
  t.after(async () => {
    try {
      await client.close();
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(real, { recursive: true, force: true });
    }
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...TOOL_NAMES].sort());
});
