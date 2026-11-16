import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { get } from "node:http";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvasFixture } from "../evals/support/canvas-host.mjs";
import { getSessionLogs } from "../evals/support/canvas-sdk.mjs";

const extension = new URL("../plugins/session-lens/com.github.copilot/extensions/session-lens/extension.mjs", import.meta.url);
const present = existsSync(extension);
const options = { skip: !present && "Session Lens was removed." };
const records = present ? await import("../plugins/session-lens/com.github.copilot/extensions/session-lens/records.mjs") : null;
const tokens = present ? await import("../plugins/session-lens/com.github.copilot/extensions/session-lens/tokens.mjs") : null;
const activity = present ? await import("../plugins/session-lens/com.github.copilot/extensions/session-lens/activity.mjs") : null;
const primitives = present ? await import("../plugins/session-lens/com.github.copilot/extensions/session-lens/primitives.mjs") : null;
const event = (id, type, data, extra = {}) => ({ id, type, data, timestamp: `2026-01-01T00:00:${String(Number(id.replace(/\D/g, "")) % 60 || 0).padStart(2, "0")}.000Z`, parentId: null, ...extra });
const receipt = (id, data = {}, extra = {}) => event(id, "session.usage_record", { usage: { model: "synthetic-model", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100, ...data } }, extra);
const start = (id = "alpha") => event("start", "session.start", { sessionId: id });
async function fixture(t, rows, id = "alpha") {
  const root = await mkdtemp(join(tmpdir(), "session-lens-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, id));
  const path = join(root, id, "events.jsonl");
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { root, path };
}

test("durable receipts deduplicate and never add checkpoints, live copies, or child summaries", options, async (t) => {
  const usage = receipt("1", { accounting: { sourceSessionId: "source", usageId: "usage" } });
  const { root } = await fixture(t, [
    start(), usage, usage, { ...usage, id: "another-envelope" },
    event("2", "assistant.usage", { inputTokens: 9999, outputTokens: 9999 }),
    event("3", "session.usage_checkpoint", { accountingSnapshot: { totalNanoAiu: 99 }, modelMetrics: { ignored: { usage: { inputTokens: 9999 } } } }),
    event("4", "subagent.completed", { toolCallId: "child", totalTokens: 9000 }),
    receipt("5", {}, { agentId: "child" }),
    event("6", "session.shutdown", { currentTokens: 500, systemTokens: 100, conversationTokens: 300, toolDefinitionsTokens: 50 }),
  ]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.usage.records, 2);
  assert.equal(data.usage.inputTokens, 2000);
  assert.equal(data.usage.outputTokens, 400);
  assert.equal(data.usage.uncachedInput, 1200);
  assert.equal(data.coverage.duplicates, 2);
  assert.equal(data.context.currentTokens, 500);
  assert.equal(data.context.tokenLimit, null);
});

test("missing and conflicting cache fields remain unknown; real zero survives", options, async (t) => {
  const { root } = await fixture(t, [start(), receipt("1", { cacheReadTokens: undefined, outputTokens: 0 })]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.usage.cacheReadTokens, null);
  assert.equal(data.usage.outputTokens, 0);
  assert.equal(data.usage.uncachedInput, null);
  assert.equal(data.usage.partial, true);
  const fold = records.createFold("alpha");
  fold.visit(start(), 1, 100, { duplicates: 0, missingIds: 0 });
  fold.visit(receipt("2", { inputTokens: 100, cacheReadTokens: 200 }), 2, 100, { duplicates: 0, missingIds: 0 });
  const invalid = fold.finish({});
  assert.equal(invalid.usage.conflicted, true);
  assert.equal(invalid.usage.uncachedInput, null);
});

test("partial tails, corrupt records, oversized lines, rotation, and new event types are visible", options, async (t) => {
  const { root, path } = await fixture(t, [start(), event("1", "future.event", { safe: true })]);
  await appendFile(path, `not JSON\n${"x".repeat(records.LIMITS.lineBytes + 1)}\n{"type":`);
  await writeFile(join(root, "alpha", "events.1.jsonl"), "{}\n");
  const data = await records.readSession(root, "alpha");
  assert.equal(data.coverage.malformed, 1);
  assert.equal(data.coverage.oversizedLines, 1);
  assert.equal(data.coverage.partialTail, true);
  assert.equal(data.coverage.rotated, true);
  assert.equal(data.coverage.complete, false);
  assert.equal(data.events[1].type, "future.event");
  assert.ok(data.coverage.warnings.length >= 4);
});

test("tool pairing preserves failure, overlap, incomplete calls, files, and background launch", options, async (t) => {
  const { root } = await fixture(t, [
    start(),
    event("1", "tool.execution_start", { toolCallId: "a", toolName: "view", arguments: { path: "src/example.js" } }),
    event("2", "tool.execution_start", { toolCallId: "b", toolName: "bash", arguments: { command: "node example.js", mode: "async" } }),
    event("3", "tool.execution_start", { toolCallId: "c", toolName: "rg", arguments: { paths: ["src"] } }),
    event("4", "tool.execution_complete", { toolCallId: "a", success: false }),
    event("5", "tool.execution_complete", { toolCallId: "b", success: true }),
  ]);
  const data = await records.readSession(root, "alpha");
  assert.deepEqual([data.counts.completed, data.counts.failed, data.counts.incomplete], [2, 1, 1]);
  assert.equal(data.tools[0].duration, 3000);
  assert.equal(data.tools[1].duration, 3000);
  assert.equal(data.tools[1].command.background, true);
  assert.equal(data.files[0].success, false);
  assert.equal(data.files[1].kind, "search");
});

test("source boundaries reject traversal, symlink escape, and mismatched identity", options, async (t) => {
  const { root } = await fixture(t, [start("different")]);
  await assert.rejects(records.readSession(root, "../alpha"), { code: "invalid_session" });
  await assert.rejects(records.readSession(root, "alpha"), { code: "identity_mismatch" });
  const outside = await mkdtemp(join(tmpdir(), "session-lens-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "events.jsonl"), JSON.stringify(start("escape")) + "\n");
  await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(records.readSession(root, "escape"), { code: "unsafe_source" });
});

test("refresh notices appends; local details never enter aggregate action payloads", options, async (t) => {
  const secret = "SYNTHETIC_PRIVATE_TEXT <script>alert('no')</script>";
  const { root, path } = await fixture(t, [start(), event("1", "user.message", { content: secret })]);
  const store = records.createStore(root);
  const before = await store.read("alpha");
  await appendFile(path, JSON.stringify(receipt("2")) + "\n");
  const after = await store.read("alpha");
  assert.equal(before.usage.records, 0);
  assert.equal(after.usage.records, 1);
  assert.doesNotMatch(JSON.stringify(records.publicSummary(after)), /SYNTHETIC|script|content/);
  assert.match((await store.detail("alpha", 2)).content, /SYNTHETIC_PRIVATE_TEXT/);
  const overview = await store.overview({ historyDays: 0 });
  assert.equal(overview.scanned, 1);
  assert.equal(overview.sessions[0].daily[0].usage.inputTokens, 1000);
});

test("cache diagnostics are separate snapshots, not invented additive context totals", options, async (t) => {
  const { root } = await fixture(t, [start(), event("1", "session.usage_checkpoint", {
    accountingSnapshot: { totalNanoAiu: 0, aiCreditsStatus: "complete" },
    promptCacheBreakState: [{ models: { example: { prompt_tokens: 300, tool_tokens: 90, frontier_tokens: 250,
      conversation: { message_count: 7 }, system_segments: [{ segment: "system", tokens: 100 }] } } }],
  })]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.context, null);
  assert.equal(data.cacheSnapshots[0].promptTokens, 300);
  assert.equal(data.cacheSnapshots[0].systemSegments[0].tokens, 100);
  assert.equal(data.accounting.nanoAiu, 0);
  assert.equal(data.usage.inputTokens, null);
});

test("canvas opens, acts, reopens, enforces local HTTP boundaries, and closes its server", options, async (t) => {
  const original = process.env.COPILOT_HOME;
  const home = await mkdtemp(join(tmpdir(), "session-lens-home-"));
  await mkdir(join(home, "session-state"));
  await mkdir(join(home, "session-state", "alpha"));
  await writeFile(join(home, "session-state", "alpha", "events.jsonl"), [start(), receipt("1")].map(JSON.stringify).join("\n") + "\n");
  process.env.COPILOT_HOME = home;
  t.after(async () => {
    if (original === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = original;
    await rm(home, { recursive: true, force: true });
  });
  const host = await createCanvasFixture({ extension: fileURLToPath(extension) });
  t.after(() => host.close());
  assert.deepEqual(getSessionLogs(), [], "Registering the extension must not write session log events.");
  const id = "parts-bin-session-lens";
  await host.callTool("open_canvas", { canvasId: id, instanceId: "main" });
  const url = host.panelUrl("main");
  const index = await fetch(url);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Session Lens/);
  const cookie = index.headers.get("set-cookie").split(";")[0];
  const initialState = await (await fetch(new URL("api/state", url), { headers: { Cookie: cookie } })).json();
  assert.equal(initialState.view, "activity");
  assert.equal(initialState.selected, null);
  assert.equal((await fetch(new URL("api/sessions", url))).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    get(url, { headers: { Host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(url, { headers: { Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await fetch(new URL("api/session?id=alpha", url), { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(new URL("api/detail?id=alpha&line=1", url), { headers: { Cookie: cookie } })).status, 403);
  assert.equal((await fetch(new URL("api/session?id=../alpha", url), { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(new URL("api/overview?timeZone=Invalid/Zone", url), { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await fetch(new URL("api/overview?offset=-1", url), { headers: { Cookie: cookie } })).status, 400);
  await host.callTool("open_canvas", { canvasId: id, instanceId: "second" });
  const secondIndex = await fetch(host.panelUrl("second"));
  const secondCookie = secondIndex.headers.get("set-cookie").split(";")[0];
  assert.notEqual(cookie.split("=")[0], secondCookie.split("=")[0]);
  assert.equal((await fetch(new URL("api/state", url), { headers: { Cookie: `${cookie}; ${secondCookie}` } })).status, 200);
  assert.equal((await fetch(new URL("api/state", host.panelUrl("second")), { headers: { Cookie: `${cookie}; ${secondCookie}` } })).status, 200);
  const selected = await host.callTool("invoke_canvas_action", { instanceId: "main", actionName: "select_session", input: { sessionId: "alpha" } });
  assert.equal(selected.board.usage.inputTokens, 1000);
  await host.callTool("open_canvas", { canvasId: id, instanceId: "main" });
  assert.equal(host.panelUrl("main"), url);
  const snapshot = await host.callTool("invoke_canvas_action", { instanceId: "main", actionName: "get_snapshot" });
  assert.equal(snapshot.board.id, "alpha");
  const sessionState = await (await fetch(new URL("api/state", url), { headers: { Cookie: cookie } })).json();
  assert.equal(sessionState.view, "session");
  await fetch(new URL("api/navigation?view=activity", url), { headers: { Cookie: cookie } });
  assert.equal((await (await fetch(new URL("api/state", url), { headers: { Cookie: cookie } })).json()).view, "activity");
  await host.closePanel("main");
  await assert.rejects(fetch(url));
});

test("token composition keeps recorded counts, estimates, unknowns, and conflicts distinct", options, () => {
  assert.equal(tokens.estimateText("abcdefgh").value, 2);
  assert.equal(tokens.estimateText("\u4f60\u597d").value, 2);
  assert.equal(tokens.estimateText(undefined).value, null);
  assert.equal(tokens.estimateText("").value, 0);
  const result = tokens.composition({ user: 10, results: 30 }, { system: 100, schemas: 200 }, 1000);
  assert.equal(result.total.value, 1000);
  assert.equal(result.parts.find((part) => part.id === "system").tokens.basis, "recorded");
  assert.equal(result.parts.find((part) => part.id === "user").tokens.value, 175);
  assert.equal(result.parts.find((part) => part.id === "results").tokens.value, 525);
  assert.equal(result.parts.find((part) => part.id === "results").tokens.basis, "attributed");
  assert.equal(result.chartTotal, 1000);
  assert.equal(result.parts.find((part) => part.id === "reasoning").tokens.value, null);
  assert.equal(tokens.composition({}, { system: 20 }, 100).parts.find((part) => part.id === "other").tokens.value, 80);
  const conflict = tokens.composition({ user: 30 }, { system: 120 }, 100);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.total.value, 100);
  assert.equal(conflict.parts[0].tokens.value, 120);
  const delta = tokens.deltaParts(tokens.composition({ user: 10 }, { system: 100 }, 600), tokens.composition({ user: 10 }, { system: 100 }, 1000));
  assert.equal(delta.find((part) => part.id === "user").value, -400);
  assert.equal(delta.find((part) => part.id === "system").value, 0);
  assert.equal(tokens.deltaParts(result, undefined).every((part) => part.value === null), true);
});

test("request history matches snapshots in either event order without counting response text as input", options, async (t) => {
  const checkpoint = (id, callId, prompt, system) => event(id, "session.usage_checkpoint", {
    promptCacheBreakState: [{ models: { model: { model: "synthetic-model", model_call_id: callId, prompt_tokens: prompt,
      tool_tokens: 100, tools: [{ name: "view" }], system_segments: [{ segment: "system", tokens: system }] } } }],
  });
  const { root } = await fixture(t, [
    start(), event("1", "user.message", { content: "a".repeat(40) }),
    receipt("2", { apiCallId: "request-a" }), checkpoint("3", "request-a", 1000, 100),
    event("4", "assistant.message", { apiCallId: "request-a", content: "b".repeat(400), reasoningText: "c".repeat(40) }),
    event("5", "tool.execution_start", { toolCallId: "tool", toolName: "view", arguments: { path: "example" } }),
    event("6", "tool.execution_complete", { toolCallId: "tool", success: true, result: { content: "d".repeat(40), detailedContent: "d".repeat(4000) } }),
    event("7", "assistant.message", { apiCallId: "request-b", content: "e".repeat(800) }),
    receipt("8", { apiCallId: "request-b", inputTokens: 2000 }), checkpoint("9", "request-b", 2000, 150),
    checkpoint("10", "request-b", 2000, 150),
  ]);
  const data = await records.readSession(root, "alpha");
  const [a, b] = data.contextView.history;
  assert.equal(data.contextView.history.length, 2);
  assert.equal(a.source, "Matched prompt snapshot");
  assert.equal(a.composition.total.value, 1000);
  assert.equal(a.composition.parts.find((part) => part.id === "assistant").tokens.value, null);
  assert.equal(b.composition.total.value, 2000);
  assert.equal(b.composition.parts[0].tokens.value, 150);
  assert.equal(b.boundary, 7);
  assert.equal(data.contextView.items.find((item) => item.category === "results").tokens.value, 10);
  assert.equal(data.contextView.items.find((item) => item.category === "reasoning").tokens.value, 10);
  assert.doesNotMatch(JSON.stringify(data.contextView), /aaaaaaaa|bbbbbbbb|dddddddd/);
});

test("context stays isolated by agent and resets estimates only on successful compaction", options, async (t) => {
  const { root } = await fixture(t, [
    start(), event("1", "user.message", { content: "root".repeat(10) }),
    event("2", "tool.execution_start", { toolCallId: "spawn", toolName: "task", arguments: {} }),
    event("3", "subagent.started", { toolCallId: "spawn", model: "model" }, { agentId: "child" }),
    event("4", "subagent.configured", { model: "model" }, { agentId: "child" }),
    event("5", "user.message", { content: "child".repeat(100) }, { agentId: "child" }),
    receipt("6", { apiCallId: "child-call" }, { agentId: "child" }),
    event("7", "session.compaction_complete", { success: false }),
    receipt("8", { apiCallId: "root-call" }),
    event("9", "session.compaction_complete", { success: true, summary: "summary" }),
    receipt("10", { apiCallId: "after-compact" }),
    event("11", "subagent.completed", { toolCallId: "spawn", totalTokens: 42 }, { agentId: "child" }),
  ]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.agents.length, 2);
  assert.equal(data.agents.find((agent) => agent.id === "child").parent, "main");
  const [child, before, after] = data.contextView.history;
  assert.equal(child.agent, "child");
  assert.equal(before.epoch, 0); assert.equal(after.epoch, 1);
  assert.ok(before.composition.parts.find((part) => part.id === "user").tokens.value > 0);
  assert.equal(after.composition.parts.find((part) => part.id === "user").tokens.value, null);
  assert.ok(after.composition.parts.find((part) => part.id === "injected").tokens.value > 0);
});

test("unknown skill references and media are not converted into zero tokens", options, async (t) => {
  const { root } = await fixture(t, [start(),
    event("1", "skill.context_delivered_ref", { contentId: "unresolved", prefix: "ignore" }),
    event("2", "user.message", { content: "hello", attachments: [{ type: "image", size: 100 }] }),
    receipt("3"),
  ]);
  const data = await records.readSession(root, "alpha");
  const skill = data.contextView.items.find((item) => item.category === "skills");
  assert.equal(skill.tokens.value, null);
  assert.match(skill.unavailable, /reference/);
  assert.equal(data.contextView.items.find((item) => item.category === "user").attachments[0].tokens.value, null);
});

test("missing components are not carried forward and never enter observed-content charts", options, async (t) => {
  const { root } = await fixture(t, [start(), receipt("1", { apiCallId: "before" }),
    receipt("2", { apiCallId: "measured" }),
    event("3", "session.usage_checkpoint", { promptCacheBreakState: [{ models: { model: {
      model: "synthetic-model", model_call_id: "measured", prompt_tokens: 1000, tool_tokens: 200,
      system_segments: [{ segment: "system", tokens: 100 }],
    } } }] }),
    receipt("4", { apiCallId: "later" }),
    receipt("5", { apiCallId: "child" }, { agentId: "child" }),
    receipt("6", { apiCallId: "switched", model: "different-model" }),
  ]);
  const data = await records.readSession(root, "alpha");
  const [before, measured, later, child, switched] = data.contextView.history;
  assert.equal(before.composition.parts[0].tokens.value, null);
  assert.equal(measured.composition.parts[0].tokens.basis, "recorded");
  assert.equal(later.composition.parts[0].tokens.value, null);
  assert.equal(later.system.length, 0);
  assert.equal(later.schemas.length, 0);
  assert.equal(later.composition.total.basis, "recorded");
  assert.equal(child.composition.parts[0].tokens.value, null);
  assert.equal(switched.composition.parts[0].tokens.value, null);
  for (const point of data.contextView.history) {
    assert.ok(point.observed.parts.every((part) => !["system", "schemas", "other"].includes(part.id)));
  }
});

test("observed-content sizes do not allocate unobserved prompt tokens to known text", options, () => {
  const observed = tokens.contentComposition({ user: 10, results: 30, system: 10000, schemas: 5000 });
  assert.equal(observed.total.value, 40);
  assert.equal(observed.parts.find((part) => part.id === "user").tokens.value, 10);
  assert.equal(observed.parts.find((part) => part.id === "results").tokens.value, 30);
  assert.equal(observed.total.basis, "estimated");
  assert.ok(observed.parts.every((part) => part.tokens.value !== null && part.tokens.basis === "estimated"));
});

test("durable receipts take precedence over live copies with the same accounting identity", options, async (t) => {
  const first = receipt("1", { accounting: { usageId: "a", sourceSessionId: "alpha" } });
  const { root } = await fixture(t, [start(),
    event("live", "assistant.usage", first.data.usage), first,
    receipt("2", { accounting: { usageId: "b", sourceSessionId: "alpha" } }),
  ]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.usage.records, 2);
  assert.equal(data.usage.inputTokens, 2000);
  assert.equal(data.contextView.history.length, 2);
});

test("detail retention does not cap aggregate tool counters", options, () => {
  const fold = records.createFold("alpha"), coverage = { duplicates: 0, missingIds: 0 };
  fold.visit(start(), 1, 100, coverage);
  for (let i = 0; i < 10001; i++) fold.visit(event(`t${i}`, "tool.execution_start", { toolCallId: `call-${i}`, toolName: "view", arguments: {} }), i + 2, 100, coverage);
  fold.visit(event("complete", "tool.execution_complete", { toolCallId: "call-10000", success: false }), 10004, 100, coverage);
  const result = fold.finish(coverage);
  assert.equal(result.counts.tools, 10001);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.toolRanking[0].count, 10001);
  assert.equal(result.tools.length, 10000);
});

test("calendar ranges use local dates, inclusive endpoints, and DST rather than rolling hours", options, () => {
  const now = new Date("2026-11-02T07:30:00Z"); // Still Nov 1 in Los Angeles after the DST transition.
  assert.deepEqual(activity.resolveRange({ preset: "today" }, "America/Los_Angeles", now), { from: "2026-11-01", to: "2026-11-01" });
  assert.deepEqual(activity.resolveRange({ preset: "7" }, "America/Los_Angeles", now), { from: "2026-10-26", to: "2026-11-01" });
  assert.deepEqual(activity.resolveRange({ preset: "yesterday" }, "America/Los_Angeles", now), { from: "2026-10-31", to: "2026-10-31" });
  assert.deepEqual(activity.resolveRange({ preset: "today" }, "Asia/Tokyo", now), { from: "2026-11-02", to: "2026-11-02" });
  assert.throws(() => activity.resolveRange({ preset: "custom", from: "2026-02-30", to: "2026-03-02" }, "UTC"), /valid/);
  assert.throws(() => activity.resolveRange({ preset: "custom", from: "2026-11-03", to: "2026-11-01" }, "UTC"), /on or before/);
});

test("date totals, rows, and rankings include only that day's events in a multi-day session", options, async (t) => {
  const at = (event, timestamp) => ({ ...event, timestamp });
  const firstUsage = receipt("2", { model: "prior-day", inputTokens: 9000 });
  const todayUsage = receipt("5", { model: "today-model", inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0,
    accounting: { sourceSessionId: "alpha", usageId: "only-once" } });
  const { root } = await fixture(t, [
    at(start(), "2026-10-31T22:00:00Z"),
    at(event("1", "user.message", { content: "SYNTHETIC_PRIVATE_MESSAGE" }), "2026-11-01T06:59:59Z"),
    at(firstUsage, "2026-11-01T06:59:59Z"),
    at(event("3", "tool.execution_start", { toolCallId: "old", toolName: "old-tool", arguments: {} }), "2026-11-01T06:59:59Z"),
    at(event("4", "user.message", { content: "new day" }), "2026-11-01T07:00:00Z"),
    at(todayUsage, "2026-11-01T08:30:00Z"),
    at({ ...todayUsage, id: "duplicate" }, "2026-11-01T09:30:00Z"),
    at(event("6", "tool.execution_start", { toolCallId: "new", toolName: "today-tool", arguments: { content: "SYNTHETIC_PRIVATE_PAYLOAD" } }), "2026-11-01T09:30:00Z"),
    at(event("7", "tool.execution_complete", { toolCallId: "old", success: false }), "2026-11-02T07:59:59Z"),
    at(event("8", "skill.invoked", { name: "today-skill" }), "2026-11-02T07:59:59Z"),
    at(receipt("9", { model: "tomorrow-model", inputTokens: 8000 }), "2026-11-02T08:00:00Z"),
  ]);
  const summary = await records.readSession(root, "alpha", { summaryOnly: true, timeZone: "America/Los_Angeles" });
  const result = activity.summarizeActivity([summary], { from: "2026-11-01", to: "2026-11-01" });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.total.usage.inputTokens, 100);
  assert.equal(result.total.usage.outputTokens, 20);
  assert.equal(result.total.usage.cacheReadTokens, 50);
  assert.equal(result.total.usage.records, 1);
  assert.equal(result.total.turns, 1);
  assert.equal(result.total.tools, 1);
  assert.equal(result.total.failed, 1);
  assert.deepEqual(result.total.rankings.models.map((item) => item.name), ["today-model"]);
  assert.deepEqual(result.total.rankings.tools.map((item) => item.name), ["today-tool"]);
  assert.deepEqual(result.total.rankings.skills.map((item) => item.name), ["today-skill"]);
  assert.equal(result.sessions[0].usage.inputTokens, result.total.usage.inputTokens);
  assert.equal(summary.contextView, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /SYNTHETIC_PRIVATE/);
  const noMatch = activity.summarizeActivity([summary], { from: "2026-11-05", to: "2026-11-05" });
  assert.equal(noMatch.sessions.length, 0);
  assert.equal(noMatch.total.usage.inputTokens, null);
});

test("missing usage stays missing, and undated events make date coverage partial", options, async (t) => {
  const { root } = await fixture(t, [start(),
    receipt("1", { inputTokens: undefined, outputTokens: 0 }),
    { ...event("2", "tool.execution_start", { toolCallId: "undated", toolName: "view", arguments: {} }), timestamp: null },
  ]);
  const summary = await records.readSession(root, "alpha", { summaryOnly: true, timeZone: "UTC" });
  const result = activity.summarizeActivity([summary], { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(result.total.usage.inputTokens, null);
  assert.equal(result.total.usage.missing.inputTokens, 1);
  assert.equal(result.total.usage.outputTokens, 0);
  assert.equal(result.total.tools, 0);
  assert.equal(result.partialSessions, 1);
  assert.equal(summary.coverage.undated, 1);
});

test("progressive activity scans reach beyond the latest 100-session picker and refresh changed summaries", options, async (t) => {
  const { root, path } = await fixture(t, [start(), receipt("1")]);
  for (let i = 0; i < 105; i++) {
    const id = `synthetic-${i}`;
    await mkdir(join(root, id));
    await writeFile(join(root, id, "events.jsonl"), [start(id), receipt("1")].map(JSON.stringify).join("\n") + "\n");
  }
  const store = records.createStore(root);
  assert.equal((await store.list()).sessions.length, 100);
  const collected = [], pageSizes = [];
  let page = await store.overview({ timeZone: "UTC", historyDays: 0 });
  const scanId = page.scanId;
  while (true) {
    collected.push(...page.sessions); pageSizes.push(page.sessions.length);
    if (page.nextOffset === null) break;
    page = await store.overview({ timeZone: "UTC", scanId, offset: page.nextOffset, historyDays: 0 });
  }
  assert.equal(page.scanned, 106);
  assert.equal(collected.length, 106);
  assert.equal(new Set(collected.map((row) => row.id)).size, 106);
  assert.ok(pageSizes.every((size) => size <= 20));
  const result = activity.summarizeActivity(collected, { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(result.total.usage.inputTokens, 106000);
  assert.equal(result.total.usage.records, 106);
  await assert.rejects(store.overview({ timeZone: "America/Los_Angeles", scanId, offset: 0 }), { code: "invalid_scan" });
  await assert.rejects(store.overview({ timeZone: "UTC", scanId: "nonexistent" }), { code: "scan_expired" });
  await appendFile(path, JSON.stringify(receipt("2")) + "\n");
  const refreshed = await store.overview({ timeZone: "UTC", historyDays: 0 });
  assert.notEqual(refreshed.scanId, scanId);
  assert.equal(refreshed.sessions.find((session) => session.id === "alpha").daily[0].usage.records, 2);
});

test("daily chart buckets include empty dates and preserve totals when grouped", options, () => {
  const first = { day: "2026-01-01", ...activity.emptyActivity() };
  first.events = 5; first.usage.records = 1; first.usage.inputTokens = 100;
  const last = { day: "2026-12-31", ...activity.emptyActivity() };
  last.events = 3; last.usage.records = 1; last.usage.outputTokens = 20;
  const buckets = activity.rangeDays({ from: "2026-01-01", to: "2026-12-31" }, [first, last]);
  assert.ok(buckets.length <= 90);
  assert.equal(buckets[0].from, "2026-01-01");
  assert.equal(buckets.at(-1).to, "2026-12-31");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.events, 0), 8);
  assert.equal(buckets.reduce((sum, bucket) => sum + (bucket.usage.inputTokens ?? 0), 0), 100);
  const days = activity.rangeDays({ from: "2026-01-01", to: "2026-01-03" }, [first]);
  assert.equal(days.length, 3);
  assert.equal(days[1].usage.inputTokens, null);
});

test("hourly summaries separate repeated DST hours and exclude future slots from selection", options, async (t) => {
  const at = (row, timestamp) => ({ ...row, timestamp });
  const { root } = await fixture(t, [
    at(start(), "2026-11-01T07:00:00Z"),
    at(receipt("1", { inputTokens: 100 }), "2026-11-01T08:15:00Z"),
    at(receipt("2", { inputTokens: 200 }), "2026-11-01T09:15:00Z"),
  ]);
  const summary = await records.readSession(root, "alpha", { summaryOnly: true, timeZone: "America/Los_Angeles" });
  const hours = activity.rangeHours("2026-11-01", [summary], "America/Los_Angeles", new Date("2026-11-01T10:30:00Z"));
  assert.equal(hours.length, 25);
  const repeated = hours.filter((hour) => hour.hour === "01");
  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0].key, repeated[1].key);
  assert.equal(repeated[0].usage.inputTokens, 100);
  assert.equal(repeated[1].usage.inputTokens, 200);
  assert.equal(hours.filter((hour) => hour.future).length, 21);
  const filtered = activity.summarizeActivity([summary], { from: "2026-11-01", to: "2026-11-01" }, null, repeated[1].key);
  assert.equal(filtered.total.usage.inputTokens, 200);
  assert.equal(filtered.sessions[0].usage.inputTokens, 200);
  const spring = activity.rangeHours("2026-03-08", [], "America/Los_Angeles");
  assert.equal(spring.length, 23);
  assert.ok(!spring.some((hour) => hour.hour === "02"));
  const fractional = activity.rangeHours("2026-11-01", [], "Asia/Kathmandu");
  assert.equal(fractional.length, 24);
});

test("adaptive date buckets use calendar weeks, months, and years and keep every observation", options, () => {
  const row = { day: "2024-02-29", ...activity.emptyActivity() };
  row.events = 3; row.usage.inputTokens = 300;
  const weeks = activity.rangeDays({ from: "2024-02-01", to: "2024-04-01" }, [row]);
  assert.equal(weeks[0].unit, "week");
  assert.equal(weeks[0].to, "2024-02-04");
  const months = activity.rangeDays({ from: "2024-01-15", to: "2025-01-31" }, [row]);
  assert.equal(months[0].unit, "month");
  assert.equal(months.find((bucket) => bucket.from === "2024-02-01").to, "2024-02-29");
  assert.equal(months.reduce((sum, bucket) => sum + bucket.events, 0), 3);
  const years = activity.rangeDays({ from: "2010-01-01", to: "2026-01-01" }, [row]);
  assert.equal(years[0].unit, "year");
});

test("date-focused drill-down chooses a matching agent and positions the history window there", options, () => {
  const history = Array.from({ length: 80 }, (_, index) => ({
    id: `p${index}`, agent: "main", observed: { chartTotal: 1 },
    timestamp: index === 5 ? "2026-11-15T20:00:00Z" : "2026-11-16T20:00:00Z",
  }));
  const focus = { from: "2026-11-15", to: "2026-11-15", timeZone: "America/Los_Angeles" };
  const match = activity.sessionFocus(history, focus);
  assert.equal(match.pinned, "p5");
  assert.equal(match.end, 48);
  assert.equal(activity.focusMatcher(focus)(history[6].timestamp), false);
  assert.equal(activity.sessionFocus(history, { ...focus, from: "2026-11-17", to: "2026-11-17" }), null);
});

test("the 30-day cutoff skips old files, filters old events, and can be disabled", options, async (t) => {
  const now = new Date(), today = activity.dayFormatter("UTC")(now), cutoff = activity.shiftDay(today, -29), old = activity.shiftDay(today, -60);
  const at = (row, day) => ({ ...row, timestamp: `${day}T12:00:00Z` });
  const { root, path } = await fixture(t, [
    at({ ...start(), data: { sessionId: "alpha", title: "Recorded title", context: { cwd: "/synthetic/billing-ui" } } }, old),
    at(receipt("1", { inputTokens: 9000 }), old), at(receipt("2", { inputTokens: 100 }), today),
  ]);
  await mkdir(join(root, "archive"));
  const archive = join(root, "archive", "events.jsonl");
  await writeFile(archive, [at(start("archive"), old), at(receipt("1"), old)].map(JSON.stringify).join("\n") + "\n");
  await utimes(archive, new Date(`${old}T12:00Z`), new Date(`${old}T12:00Z`));
  const store = records.createStore(root), limited = await store.overview({ timeZone: "UTC" });
  assert.equal(limited.cutoff, cutoff);
  assert.equal(limited.available, 1);
  assert.equal(limited.excluded, 1);
  assert.equal(limited.sessions[0].daily.length, 1);
  assert.equal(limited.sessions[0].daily[0].usage.inputTokens, 100);
  assert.equal(limited.sessions[0].title, "Recorded title");
  assert.equal(limited.sessions[0].workspace, "billing-ui");
  assert.doesNotMatch(JSON.stringify(limited), /\/synthetic\//);
  const full = await store.overview({ timeZone: "UTC", historyDays: 0 });
  assert.equal(full.available, 2); assert.equal(full.cutoff, null);
  assert.equal(full.sessions.find((session) => session.id === "alpha").daily.length, 2);
  await assert.rejects(store.overview({ historyDays: 7 }), { code: "invalid_history_limit" });
  // An exact cutoff timestamp belongs to the included side.
  await utimes(path, new Date(`${cutoff}T00:00Z`), new Date(`${cutoff}T00:00Z`));
  assert.equal((await store.overview({ timeZone: "UTC" })).available, 1);
});

test("MCP counts use recorded server/tool identities without guessing from tool names", options, async (t) => {
  const mcp = (id, tool, agentId) => event(id, "tool.execution_start", {
    toolCallId: id, toolName: `provider-long-name-${tool}`, mcpServerName: "runtime-server",
    mcpConfigServerName: "configured-server", mcpServerDisplayName: "Research", mcpToolName: tool,
    arguments: { secret: "SYNTHETIC_PRIVATE_ARGUMENT" },
  }, agentId ? { agentId } : {});
  const { root } = await fixture(t, [start(), mcp("1", "search"), mcp("2", "search", "child"), mcp("3", "fetch"),
    event("4", "tool.execution_start", { toolCallId: "ordinary", toolName: "mcp-looking-search", arguments: {} }),
    event("5", "tool.execution_complete", { toolCallId: "1", success: true }),
  ]);
  const snapshot = await records.readSession(root, "alpha");
  const server = snapshot.primitives.mcps[0];
  assert.equal(server.name, "configured-server");
  assert.equal(server.displayName, "Research");
  assert.equal(server.count, 3);
  assert.equal(server.tools.find((tool) => tool.name === "search").count, 2);
  assert.deepEqual(snapshot.primitives.tools.map((tool) => tool.name), ["mcp-looking-search"]);
  assert.equal(snapshot.primitives.agents.child.mcps[0].count, 1);
  assert.doesNotMatch(JSON.stringify(snapshot.primitives), /SYNTHETIC_PRIVATE/);
  const summary = await records.readSession(root, "alpha", { summaryOnly: true });
  const aggregate = activity.summarizeActivity([summary], { from: "2026-01-01", to: "2026-01-01" });
  assert.equal(aggregate.total.rankings.mcps[0].count, 3);
  assert.equal(aggregate.total.rankings.mcps[0].tools.find((tool) => tool.name === "search").count, 2);
  assert.equal(aggregate.total.tools, 4);
  assert.equal(primitives.matchesPrimitive(aggregate.sessions[0].rankings, { kind: "mcps", name: "configured-server", tool: "fetch" }), true);
  assert.equal(primitives.matchesPrimitive(aggregate.sessions[0].rankings, { kind: "mcps", name: "configured-server", tool: "other" }), false);
});

test("model-role counts reconcile with receipts across agent, hour, day, and range scopes", options, async (t) => {
  const { root } = await fixture(t, [
    start(),
    receipt("1"),
    receipt("2", { parentToolCallId: "spawn" }, { agentId: "child" }),
    receipt("3", {}, { agentId: "unidentified" }),
    receipt("4", { parentToolCallId: "without-agent-id" }),
    event("5", "subagent.started", { toolCallId: "spawn" }, { agentId: "child" }),
  ]);
  const snapshot = await records.readSession(root, "alpha");
  const roles = { main: 1, subagent: 2, unknown: 1 };
  assert.deepEqual(snapshot.models[0].roles, roles);
  assert.deepEqual(snapshot.primitives.models[0].roles, roles);
  assert.equal(snapshot.primitives.models[0].count, 4);
  assert.equal(snapshot.primitives.agents.child.models[0].roles.subagent, 1);
  assert.equal(snapshot.primitives.events.filter((entry) => entry.kind === "models" && entry.role === "subagent").length, 2);
  assert.deepEqual(snapshot.daily[0].rankings.models[0].roles, roles);
  assert.deepEqual(snapshot.daily[0].hours[0].rankings.models[0].roles, roles);
  const aggregate = activity.summarizeActivity([snapshot, { ...snapshot, id: "second" }], { from: "2026-01-01", to: "2026-01-01" });
  assert.deepEqual(aggregate.total.rankings.models[0].roles, { main: 2, subagent: 4, unknown: 2 });
  assert.deepEqual(snapshot.daily[0].rankings.models[0].roles, roles);
  assert.equal(primitives.matchesPrimitive(snapshot.daily[0].rankings, { kind: "models", name: "synthetic-model", role: "subagent" }), true);
});

test("skills count explicit invocations, not catalog entries, tool starts, or duplicate delivery references", options, async (t) => {
  const { root } = await fixture(t, [start(),
    event("1", "tool.execution_start", { toolCallId: "load", toolName: "skill", arguments: { skill: "triage" } }),
    event("2", "skill.invoked_ref", { name: "triage", contentId: "content", contentLength: 80 }),
    event("3", "skill.context_delivered_ref", { contentId: "content" }),
    event("4", "skill.invoked", { name: "review", content: "abcd".repeat(20) }, { agentId: "child" }),
    event("5", "system.message", { content: "Available skills: catalog-only" }),
  ]);
  const data = await records.readSession(root, "alpha");
  assert.equal(data.counts.skills, 2);
  assert.deepEqual(data.primitives.skills.map((item) => item.name), ["review", "triage"]);
  assert.equal(data.primitives.agents.main.skills[0].name, "triage");
  assert.equal(data.primitives.agents.child.skills[0].name, "review");
  assert.equal(data.contextView.items.filter((item) => item.category === "skills").length, 2);
  assert.equal(data.contextView.items.find((item) => item.skill === "review").tokens.value, 20);
  assert.equal(data.contextView.items.find((item) => item.skill === "triage").tokens.value, null);
  assert.equal(data.primitives.events.filter((entry) => entry.kind === "skills").length, 2);
});

test("workflow filters respect selected dates and do not mutate global range totals", options, async (t) => {
  const at = (event, day) => ({ ...event, timestamp: `2026-01-${day}T12:00:00Z` });
  const { root } = await fixture(t, [start(),
    at(event("1", "skill.invoked_ref", { name: "old-skill" }), "01"),
    at(event("2", "skill.invoked_ref", { name: "new-skill" }), "02"),
    at(event("3", "tool.execution_start", { toolCallId: "old", toolName: "search", mcpServerName: "old-server", mcpToolName: "search", arguments: {} }), "01"),
    at(event("4", "tool.execution_start", { toolCallId: "new", toolName: "read", mcpServerName: "new-server", mcpToolName: "read", arguments: {} }), "02"),
  ]);
  const summary = await records.readSession(root, "alpha", { summaryOnly: true });
  const result = activity.summarizeActivity([summary], { from: "2026-01-02", to: "2026-01-02" });
  assert.equal(primitives.matchesPrimitive(result.sessions[0].rankings, { kind: "skills", name: "old-skill" }), false);
  assert.equal(primitives.matchesPrimitive(result.sessions[0].rankings, { kind: "skills", name: "new-skill" }), true);
  assert.equal(result.total.rankings.mcps[0].name, "new-server");
  assert.equal(result.total.skills, 1);
});
