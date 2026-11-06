import baseTest from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { missing } from "../scripts/examples.mjs";

// Example-only tests: skip every test here when the example's files are gone.
// The generic canvas host driving the real brainstorm extension, as its evals do.
const extensionPath = "plugins/team-brainstorm/com.github.copilot/extensions/brainstorm/extension.mjs";
const skip = missing("evals/support/canvas-host.mjs", extensionPath, "plugins/team-brainstorm/com.github.copilot/extensions/brainstorm/board.mjs");
const test = skip ? (name) => baseTest(name, { skip }) : baseTest;
const { LIMITS, createCanvasFixture } = skip ? {} : await import("../evals/support/canvas-host.mjs");
const { resolve: resolveSdk } = skip ? {} : await import("../evals/support/canvas-loader.mjs");
const { noteSchema } = skip ? {} : await import("../plugins/team-brainstorm/com.github.copilot/extensions/brainstorm/board.mjs");
const CANVAS_ID = "marketplace-starter-brainstorm";


const root = fileURLToPath(new URL("../", import.meta.url));
const hostUrl = new URL("../evals/support/canvas-host.mjs", import.meta.url);
const sdkUrl = new URL("../evals/support/canvas-sdk.mjs", import.meta.url);
// The same seed the team-brainstorm eval passes, so every session starts with one note.
const seed = JSON.stringify([{ action: "save_note", input: { text: "Keep onboarding simple", column: "ideas" } }]);
const fixtureOptions = () => ({ extension: resolve(root, extensionPath), seed: JSON.parse(seed) });
const open = (instanceId = "panel") => ({ canvasId: CANVAS_ID, instanceId });
const action = (actionName, input, instanceId = "panel") => ({
  instanceId, actionName, ...(input === undefined ? {} : { input }),
});
// Generous limits: these tests start real processes, which can be slow while
// the rest of the suite runs in parallel.
const options = { timeout: 60_000 };

async function within(promise, milliseconds = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture operation timed out.")), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class ObservedTransport extends StdioClientTransport {
  constructor(args) {
    super({ command: process.execPath, args, cwd: root, stderr: "pipe" });
    this.diagnostics = "";
    this.output = "";
    this.stderr.on("data", (data) => { this.diagnostics += data; });
  }

  async start() {
    await super.start();
    // SDK 1.32.1 exposes only pid publicly; tests also need exit status and stdin EOF.
    this.child = this._process;
    assert.equal(this.child.pid, this.pid);
    this.exited = new Promise((resolve) => this.child.once("close", (code, signal) => resolve({ code, signal })));
    this.child.stdout.on("data", (data) => { this.output += data; });
  }
}

async function startFixture(t, { script, expectedExit = 0, connect = true } = {}) {
  const args = script ? ["--input-type=module", "--eval", script] : [fileURLToPath(hostUrl), resolve(root, extensionPath), "--seed", seed];
  const transport = new ObservedTransport(args);
  const client = new Client({ name: "brainstorm-contract-test", version: "1.0.0" });
  t.after(async () => {
    try {
      await client.close();
      await transport.close();
      if (!transport.child) return;
      const exit = await within(transport.exited);
      assert.equal(exit.code, expectedExit, transport.diagnostics);
      assert.equal(exit.signal, null, "The fixture should clean up, not need a forced kill.");
      assert.throws(() => process.kill(transport.child.pid, 0), { code: "ESRCH" });
      for (const line of transport.output.trim().split("\n").filter(Boolean)) {
        assert.equal(JSON.parse(line).jsonrpc, "2.0", "stdout must contain only MCP messages.");
      }
    } finally {
      if (transport.child && transport.child.exitCode === null && transport.child.signalCode === null) {
        transport.child.kill("SIGKILL");
        await within(transport.exited);
      }
    }
  });
  if (connect) await client.connect(transport, { timeout: 30_000 });
  return {
    client, transport,
    async call(name, arguments_) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.notEqual(result.isError, true, result.content?.[0]?.text);
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.doesNotMatch(JSON.stringify(result), /https?:\/\/(?:127\.0\.0\.1|localhost)/);
      return result.structuredContent;
    },
    async error(name, arguments_) {
      const result = await client.callTool({ name, arguments: arguments_ });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.content[0].type, "text");
      assert.match(result.content[0].text, /^[a-z_]+: .+/);
      return result.content[0].text;
    },
  };
}

function assertSeed(board) {
  assert.equal(board.notes.length, 1);
  const note = board.notes[0];
  assert.deepEqual(Object.keys(note).sort(), ["column", "id", "text"]);
  assert.match(note.id, /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  assert.equal(note.text, "Keep onboarding simple");
  assert.equal(note.column, "ideas");
  return note;
}

test("loader redirects only the exact extension SDK transport specifier", async () => {
  const context = { parentURL: hostUrl.href };
  const delegated = [];
  const next = (specifier, received) => {
    assert.equal(received, context);
    delegated.push(specifier);
    return { url: `delegated:${specifier}` };
  };
  assert.deepEqual(await resolveSdk("@github/copilot-sdk/extension", context, next), {
    url: sdkUrl.href, shortCircuit: true,
  });
  for (const specifier of ["node:http", "./board.mjs", "@github/copilot-sdk", "@github/copilot-sdk/extension/other"]) {
    assert.deepEqual(await resolveSdk(specifier, context, next), { url: `delegated:${specifier}` });
  }
  assert.equal(delegated.length, 4);
});

test("stdio exposes exactly the three headless tool contracts and real action schemas", options, async (t) => {
  const fixture = await startFixture(t);
  const { tools } = await fixture.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    "list_canvas_capabilities", "open_canvas", "invoke_canvas_action",
  ]);
  for (const tool of tools) {
    assert.match(tool.description, /headless/i);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ["canvasId"]);
  assert.deepEqual(tools[0].inputSchema.required, ["canvasId"]);
  assert.deepEqual(tools[1].inputSchema.required, ["canvasId", "instanceId"]);
  assert.deepEqual(Object.keys(tools[2].inputSchema.properties), ["instanceId", "actionName", "input"]);
  assert.deepEqual(tools[2].inputSchema.required, ["instanceId", "actionName"]);
  assert.deepEqual(tools[2].inputSchema.properties.input.type, ["object", "null"]);
  const capabilities = await fixture.call("list_canvas_capabilities", { canvasId: CANVAS_ID });
  assert.deepEqual(Object.keys(capabilities).sort(), ["actions", "canvasId", "displayName", "transport"]);
  assert.equal(capabilities.canvasId, CANVAS_ID);
  assert.equal(capabilities.displayName, "Team brainstorm");
  assert.equal(capabilities.transport, "headless-sdk-contract");
  assert.deepEqual(capabilities.actions.map((entry) => entry.name), ["get_board", "save_note", "remove_note"]);
  assert.deepEqual(Object.keys(capabilities.actions[0]).sort(), ["description", "name"]);
  assert.deepEqual(capabilities.actions[1].inputSchema, noteSchema);
  assert.deepEqual(capabilities.actions[2].inputSchema, {
    type: "object", additionalProperties: false,
    properties: { id: { type: "string", minLength: 1 } }, required: ["id"],
  });
  assert.match(await fixture.error("invoke_canvas_action", action("get_board")), /unknown_instance/);
});

test("stdio actions read generated IDs and preserve real session state across turns and handles", options, async (t) => {
  const fixture = await startFixture(t);
  const opened = await fixture.call("open_canvas", open());
  assert.deepEqual(opened, { canvasId: CANVAS_ID, instanceId: "panel", title: "Team brainstorm", headless: true });
  assert.deepEqual(await fixture.call("open_canvas", open()), opened);
  const read = await fixture.call("invoke_canvas_action", action("get_board"));
  assert.deepEqual(Object.keys(read).sort(), ["actionName", "board", "canvasId", "instanceId"]);
  assert.equal(read.canvasId, CANVAS_ID);
  assert.equal(read.instanceId, "panel");
  assert.equal(read.actionName, "get_board");
  const seed = assertSeed(read.board);
  assert.deepEqual(await fixture.call("invoke_canvas_action", action("get_board", null)), read);
  const saved = await fixture.call("invoke_canvas_action", action("save_note", {
    text: "  Offer a starter checklist  ", column: "questions",
  }));
  assert.equal(saved.board.notes.length, 2);
  assert.deepEqual(saved.board.notes[0], seed);
  const added = saved.board.notes[1];
  assert.equal(added.text, "Offer a starter checklist");
  assert.notEqual(added.id, seed.id);
  const edited = await fixture.call("invoke_canvas_action", action("save_note", {
    id: added.id, text: "Offer a short checklist", column: "questions",
  }));
  assert.equal(edited.board.notes[1].text, "Offer a short checklist");
  const moved = await fixture.call("invoke_canvas_action", action("save_note", {
    id: added.id, text: "Offer a short checklist", column: "next",
  }));
  assert.deepEqual(moved.board.notes, [seed, { id: added.id, text: "Offer a short checklist", column: "next" }]);
  await fixture.call("open_canvas", open("second"));
  assert.deepEqual((await fixture.call("invoke_canvas_action", action("get_board", {}, "second"))).board, moved.board);
  const removed = await fixture.call("invoke_canvas_action", action("remove_note", { id: added.id }, "second"));
  assert.deepEqual(removed.board, { notes: [seed] });
  assert.deepEqual((await fixture.call("invoke_canvas_action", action("get_board"))).board, removed.board);
  assert.match(await fixture.error("invoke_canvas_action", action("remove_note", { id: added.id })), /invalid_note.*no longer exists/);
});

test("invalid and stale inputs return explicit MCP errors without changing the board", options, async (t) => {
  const fixture = await startFixture(t);
  await fixture.call("open_canvas", open());
  const before = (await fixture.call("invoke_canvas_action", action("get_board"))).board;
  const invalidCalls = [
    ["not_a_tool", {}],
    ["list_canvas_capabilities", { canvasId: "another-canvas" }],
    ["list_canvas_capabilities", {}],
    ["open_canvas", { canvasId: CANVAS_ID, instanceId: "" }],
    ["open_canvas", { canvasId: CANVAS_ID, instanceId: " ".repeat(3) }],
    ["open_canvas", { canvasId: CANVAS_ID, instanceId: "x".repeat(129) }],
    ["open_canvas", { ...open(), url: "forbidden" }],
    ["invoke_canvas_action", action("get_board", undefined, "unopened")],
    ["invoke_canvas_action", { ...action("get_board"), sessionId: "another-session" }],
    ["invoke_canvas_action", action("invented_action")],
    ["invoke_canvas_action", action("get_board", { extra: true })],
    ...[undefined, null, [], {}, { id: before.notes[0].id },
      { text: "", column: "ideas" }, { text: " \n ", column: "ideas" },
      { text: "x".repeat(501), column: "ideas" }, { text: "Idea", column: "unknown" },
      { text: "Idea", column: "ideas", extra: true }, { text: "Idea", column: "ideas", id: "" },
      { text: "Idea", column: "ideas", id: 7 }, { text: "Idea", column: "ideas", id: "stale" },
    ].map((input) => ["invoke_canvas_action", action("save_note", input)]),
    ...[undefined, null, {}, { id: "" }, { id: 7 }, { id: "stale" }, { id: before.notes[0].id, extra: true }]
      .map((input) => ["invoke_canvas_action", action("remove_note", input)]),
  ];
  for (const [name, input] of invalidCalls) {
    await fixture.error(name, input);
    assert.deepEqual((await fixture.call("invoke_canvas_action", action("get_board"))).board, before);
  }
  await assert.rejects(fixture.client.callTool({ name: "open_canvas", arguments: null }), /Invalid|invalid/i);
  assert.deepEqual((await fixture.call("invoke_canvas_action", action("get_board"))).board, before);
});

test("panel count is bounded and concurrent reuse of one handle is idempotent", options, async (t) => {
  const fixture = await startFixture(t);
  const repeated = await Promise.all(Array.from({ length: 8 }, () => fixture.call("open_canvas", open())));
  for (const result of repeated) assert.deepEqual(result, repeated[0]);
  for (let index = 1; index < LIMITS.panels; index += 1) {
    await fixture.call("open_canvas", open(`panel-${index}`));
  }
  assert.match(await fixture.error("open_canvas", open("over-limit")), /panel_limit/);
  assert.deepEqual(await fixture.call("open_canvas", open()), repeated[0]);
  assertSeed((await fixture.call("invoke_canvas_action", action("get_board"))).board);
});

test("each fresh fixture process starts with exactly the seed and no previous session data", options, async (t) => {
  const first = await startFixture(t);
  await first.call("open_canvas", open());
  const seed = assertSeed((await first.call("invoke_canvas_action", action("get_board"))).board);
  await first.call("invoke_canvas_action", action("remove_note", { id: seed.id }));
  assert.deepEqual((await first.call("invoke_canvas_action", action("get_board"))).board, { notes: [] });
  const second = await startFixture(t);
  await second.call("open_canvas", open());
  const fresh = assertSeed((await second.call("invoke_canvas_action", action("get_board"))).board);
  assert.notEqual(fresh.id, seed.id);
});

test("internal close/reopen uses real HTTP and SSE lifecycle without writing scratch artifacts", options, async (t) => {
  const support = new URL("../evals/support/", import.meta.url);
  const ownFiles = () => readdirSync(support).sort();
  const beforeFiles = ownFiles();
  const fixture = await createCanvasFixture(fixtureOptions());
  t.after(async () => {
    await within(fixture.close());
    assert.deepEqual(ownFiles(), beforeFiles);
  });
  await assert.rejects(createCanvasFixture(fixtureOptions()), /fresh process/);
  const opened = await fixture.callTool("open_canvas", open());
  const url = fixture.panelUrl("panel");
  assert.deepEqual(await fixture.callTool("open_canvas", open()), opened);
  assert.equal(fixture.panelUrl("panel"), url);
  const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Team brainstorm/);
  const readHttp = async (url) => {
    const response = await fetch(new URL("board", url), { signal: AbortSignal.timeout(2_000) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const seed = assertSeed(await readHttp(url));
  const saved = await fixture.callTool("invoke_canvas_action", action("save_note", {
    id: seed.id, text: seed.text, column: "next",
  }));
  assert.deepEqual(await readHttp(url), saved.board);
  const events = await fetch(new URL("events", url), { signal: AbortSignal.timeout(5_000) });
  const reader = events.body.getReader();
  t.after(async () => { await reader.cancel(); });
  assert.match(new TextDecoder().decode((await within(reader.read())).value), /"column":"next"/);
  await within(fixture.closePanel("panel"));
  assert.equal((await within(reader.read())).done, true);
  await assert.rejects(readHttp(url), /fetch failed/);
  await assert.rejects(fixture.callTool("invoke_canvas_action", action("get_board")), /Open this instanceId/);
  await assert.rejects(fixture.closePanel("panel"), /Open this instanceId/);
  await fixture.callTool("open_canvas", open());
  const reopened = fixture.panelUrl("panel");
  assert.deepEqual(await readHttp(reopened), saved.board);
  await fixture.callTool("open_canvas", open("second"));
  const second = fixture.panelUrl("second");
  await within(fixture.close());
  await within(fixture.close());
  await assert.rejects(readHttp(reopened), /fetch failed/);
  await assert.rejects(readHttp(second), /fetch failed/);
  await assert.rejects(fixture.callTool("open_canvas", open()), /closing/);
});

function lifecycleScript({ signal, failOpen = false, hangClose = false } = {}) {
  return `
    import { createCanvasFixture, runStdio } from ${JSON.stringify(hostUrl.href)};
    import { getRegisteredCanvases } from ${JSON.stringify(sdkUrl.href)};
    await runStdio(async () => {
      const fixture = await createCanvasFixture(${JSON.stringify(fixtureOptions())});
      const canvas = getRegisteredCanvases()[0];
      const realOpen = canvas.open;
      const realClose = canvas.onClose;
      const opened = new Set();
      const closed = new Set();
      canvas.open = async (ctx) => {
        const result = await realOpen(ctx);
        opened.add(ctx.instanceId);
        if (${failOpen}) throw new Error("deliberate runtime failure after opening");
        return result;
      };
      canvas.onClose = async (ctx) => {
        await realClose(ctx);
        closed.add(ctx.instanceId);
        process.stderr.write("real onClose completed: " + ctx.instanceId + "\\n");
        if (${hangClose}) await new Promise(() => {});
      };
      process.once("exit", () => {
        if ([...opened].some((id) => !closed.has(id))) {
          process.stderr.write("Owned panel missed real onClose\\n");
          process.exitCode = 99;
        }
      });
      const call = fixture.callTool.bind(fixture);
      fixture.callTool = async (name, input) => {
        const result = await call(name, input);
        if (${Boolean(signal)} && process.platform === "win32" && name === "invoke_canvas_action") {
          setTimeout(() => process.emit(${JSON.stringify(signal ?? "SIGTERM")}), 50);
        }
        return result;
      };
      return fixture;
    });
  `;
}

for (const signal of ["EOF", "SIGINT", "SIGTERM"]) {
  test(`${signal} closes every real panel and exits without a forced kill`, options, async (t) => {
    const fixture = await startFixture(t, { script: lifecycleScript({ signal: signal === "EOF" ? undefined : signal }) });
    await fixture.call("open_canvas", open());
    await fixture.call("open_canvas", open("second"));
    await fixture.call("invoke_canvas_action", action("get_board"));
    if (signal === "EOF") fixture.transport.child.stdin.end();
    // Windows kill() terminates abruptly; exercise Node's registered signal events there.
    else if (process.platform !== "win32") fixture.transport.child.kill(signal);
    assert.equal((await within(fixture.transport.exited)).code, 0, fixture.transport.diagnostics);
    assert.match(fixture.transport.diagnostics, /real onClose completed: panel/);
    assert.match(fixture.transport.diagnostics, /real onClose completed: second/);
  });
}

test("bootstrap failure exits nonzero instead of serving a fallback", options, async (t) => {
  const fixture = await startFixture(t, {
    connect: false, expectedExit: 1,
    script: `import { runStdio } from ${JSON.stringify(hostUrl.href)};
      await runStdio(async () => { throw new Error("deliberate bootstrap failure"); });`,
  });
  await assert.rejects(fixture.client.connect(fixture.transport, { timeout: 30_000 }));
  assert.equal((await within(fixture.transport.exited)).code, 1);
  assert.match(fixture.transport.diagnostics, /deliberate bootstrap failure/);
  assert.equal(fixture.transport.output, "");
});

test("runtime failure after real open still closes its owned panel and exits nonzero", options, async (t) => {
  const fixture = await startFixture(t, { script: lifecycleScript({ failOpen: true }), expectedExit: 1 });
  await assert.rejects(fixture.client.callTool({ name: "open_canvas", arguments: open() }), /runtime failed|Connection closed/i);
  assert.equal((await within(fixture.transport.exited)).code, 1);
  assert.match(fixture.transport.diagnostics, /deliberate runtime failure/);
  assert.match(fixture.transport.diagnostics, /real onClose completed: panel/);
});

test("shutdown has a deadline even if a lifecycle callback does not settle", options, async (t) => {
  const fixture = await startFixture(t, { script: lifecycleScript({ hangClose: true }), expectedExit: 1 });
  await fixture.call("open_canvas", open());
  fixture.transport.child.stdin.end();
  assert.equal((await within(fixture.transport.exited, LIMITS.shutdownMs + 3_000)).code, 1);
  assert.match(fixture.transport.diagnostics, /real onClose completed: panel/);
  assert.match(fixture.transport.diagnostics, /cleanup exceeded its deadline/);
});
