import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { hostOptions } from "../evals/support/canvas-host.mjs";
import { readEvals, root } from "../scripts/validate-evals.mjs";
import { evalParams } from "../scripts/evals.mjs";

const host = fileURLToPath(new URL("../evals/support/canvas-host.mjs", import.meta.url));
const options = { timeout: 60_000 };

// A tiny extension written the way a new canvas plugin would be.
const extension = `
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
const items = new Map();
const list = (ctx) => items.get(ctx.sessionId) ?? items.set(ctx.sessionId, []).get(ctx.sessionId);
await joinSession({ canvases: [createCanvas({
  id: "fixture-list", displayName: "Fixture list",
  actions: [
    { name: "get_items", description: "Read the items.", handler: async (ctx) => ({ items: [...list(ctx)] }) },
    { name: "add_item", description: "Add an item.",
      inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1 } }, required: ["text"] },
      handler: async (ctx) => {
        if (ctx.input.text === "reject") throw new CanvasError("invalid_item", "That item isn't allowed.");
        list(ctx).push(ctx.input.text);
        return { items: [...list(ctx)] };
      } },
  ],
  async open() { return { title: "Fixture list", url: "http://127.0.0.1:9/" }; },
  async onClose() {},
})] });
`;

async function connect(t, args) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [host, ...args], cwd: root, stderr: "pipe" });
  let diagnostics = "";
  transport.stderr.on("data", (data) => { diagnostics += data; });
  const client = new Client({ name: "canvas-host-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport, { timeout: 30_000 });
  return { client, diagnostics: () => diagnostics };
}

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  return result.isError ? { error: result.content[0].text } : result.structuredContent;
};

test("host options name the extension, an optional canvas, and a JSON seed", () => {
  assert.deepEqual(hostOptions(["ext.mjs"]).seed, []);
  assert.equal(hostOptions(["ext.mjs", "--canvas", "board"]).canvasId, "board");
  assert.deepEqual(hostOptions(["ext.mjs", "--seed", '[{"action":"add","input":{}}]']).seed, [{ action: "add", input: {} }]);
  assert.throws(() => hostOptions([]), /Usage/);
  assert.throws(() => hostOptions(["ext.mjs", "--seed", "{"]), /--seed must be/);
  assert.throws(() => hostOptions(["ext.mjs", "--seed", '[{"input":{}}]']), /--seed must be/);
});

test("the host drives any canvas extension's real actions, seed, and errors over MCP", options, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-canvas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "extension.mjs");
  await writeFile(path, extension);
  const { client } = await connect(t, [path, "--seed", '[{"action":"add_item","input":{"text":"Seeded"}}]']);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["list_canvas_capabilities", "open_canvas", "invoke_canvas_action"]);
  assert.equal(tools[0].inputSchema.properties.canvasId.const, "fixture-list");
  const capabilities = await call(client, "list_canvas_capabilities", { canvasId: "fixture-list" });
  assert.equal(capabilities.transport, "headless-sdk-contract");
  assert.deepEqual(capabilities.actions.map((action) => action.name), ["get_items", "add_item"]);
  assert.match((await call(client, "invoke_canvas_action", { instanceId: "a", actionName: "get_items" })).error, /^unknown_instance:/);
  assert.equal((await call(client, "open_canvas", { canvasId: "fixture-list", instanceId: "a" })).headless, true);
  assert.deepEqual((await call(client, "invoke_canvas_action", { instanceId: "a", actionName: "get_items" })).board, { items: ["Seeded"] });
  const added = await call(client, "invoke_canvas_action", { instanceId: "a", actionName: "add_item", input: { text: "Second" } });
  assert.deepEqual(added.board, { items: ["Seeded", "Second"] });
  assert.match((await call(client, "invoke_canvas_action", { instanceId: "a", actionName: "add_item", input: { text: "reject" } })).error, /^invalid_item: That item isn't allowed\./);
  assert.match((await call(client, "invoke_canvas_action", { instanceId: "a", actionName: "add_item", input: {} })).error, /^invalid_input:/);
});

test("a wrong canvas ID or seed action stops the host with a clear message", options, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-canvas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "extension.mjs");
  await writeFile(path, extension);
  for (const [args, message] of [[["--canvas", "other"], /registers fixture-list\. None is other\./], [["--seed", '[{"action":"nope"}]'], /unknown action nope/]]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [host, path, ...args], cwd: root, stderr: "pipe" });
    let diagnostics = "";
    transport.stderr.on("data", (data) => { diagnostics += data; });
    const client = new Client({ name: "canvas-host-test", version: "1.0.0" });
    await assert.rejects(client.connect(transport, { timeout: 30_000 }));
    await client.close().catch(() => {});
    assert.match(diagnostics, message);
  }
});

// Every eval that uses the canvas host must start it with real arguments, so a
// broken extension path, canvas ID, or seed fails here instead of in a paid run.
test("every eval transport that uses the canvas host starts and opens its canvas", options, async (t) => {
  const expand = (value) => String(value).replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) => evalParams[name] ?? match);
  const servers = new Map();
  for (const { path, spec } of await readEvals(root)) {
    for (const environment of [spec.agent_environment, ...(spec.stimuli ?? []).map((stimulus) => stimulus.agent_environment)]) {
      for (const [name, server] of Object.entries(environment?.mcpServers ?? {})) {
        if (!(server.args ?? []).some((arg) => String(arg).includes("${CANVAS_HOST}"))) continue;
        servers.set(JSON.stringify(server.args), { where: `${path} (${name})`, args: server.args.map(expand).slice(1) });
      }
    }
  }
  if (!servers.size) return t.skip("No eval uses the canvas host.");
  for (const { where, args } of servers.values()) {
    assert.ok(args.every((arg) => !arg.includes("${")), `${where}: every param must be defined in .vally.yaml.`);
    const { client } = await connect(t, args);
    const { tools } = await client.listTools();
    const canvasId = tools[0].inputSchema.properties.canvasId.const;
    const capabilities = await call(client, "list_canvas_capabilities", { canvasId });
    assert.ok(capabilities.actions.length, `${where}: the canvas registers no actions.`);
    const opened = await call(client, "open_canvas", { canvasId, instanceId: "verify" });
    assert.equal(opened.headless, true, `${where}: ${opened.error}`);
    await client.close();
  }
});
