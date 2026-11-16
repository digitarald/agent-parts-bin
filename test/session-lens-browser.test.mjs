import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const extension = new URL("../plugins/session-lens/com.github.copilot/extensions/session-lens/", import.meta.url);
const enabled = process.env.SESSION_LENS_BROWSER === "1";
test("activity opens on today, scopes all values, and preserves the range through session navigation", {
  skip: !enabled ? "Set SESSION_LENS_BROWSER=1 for the model-free Playwright check." : !existsSync(extension) ? "Session Lens removed." : false,
  timeout: 60_000,
}, async (t) => {
  const { chromium } = await import("@playwright/test");
  const { startServer } = await import(new URL("server.mjs", extension));
  const { createStore, LIMITS } = await import(new URL("records.mjs", extension));
  const root = await mkdtemp(join(tmpdir(), "session-lens-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = (id, type, data, day = "15") => ({ id, type, data, timestamp: `2026-11-${day}T20:00:00Z` });
  const usage = (id, inputTokens, model, day = "15") => event(id, "session.usage_record", {
    usage: { model, inputTokens, outputTokens: inputTokens / 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, day);
  async function session(id, rows, day = "15") {
    await mkdir(join(root, id));
    await writeFile(join(root, id, "events.jsonl"), [
      event(`${id}-start`, "session.start", { sessionId: id, ...(id === "alpha" ? { title: "Billing UI", context: { cwd: "/synthetic/billing" } } : {}) }, day), ...rows,
    ].map(JSON.stringify).join("\n") + "\n");
  }
  await session("alpha", [
    event("old-user", "user.message", { content: "Earlier work" }, "14"),
    usage("old", 9000, "old-model", "14"),
    event("user", "user.message", { content: "Synthetic user content" }),
    usage("new", 1000, "new-model"),
    event("tool", "tool.execution_start", { toolCallId: "call", toolName: "view", arguments: { path: "example.js" } }),
    event("skill", "skill.invoked_ref", { name: "release-notes", contentId: "skill-body" }),
    event("mcp", "tool.execution_start", { toolCallId: "mcp-call", toolName: "synthetic-find", mcpServerName: "github", mcpServerDisplayName: "GitHub", mcpToolName: "find", arguments: {} }),
    ...["get_issue", "list_pull_requests", "get_repository", "search_code", "get_checks"].map((tool, index) =>
      event(`mcp-${index}`, "tool.execution_start", { toolCallId: `mcp-${index}`, toolName: `github-${tool}`, mcpServerName: "github", mcpServerDisplayName: "GitHub", mcpToolName: tool, arguments: {} })),
    ...["read_file", "list_dir", "glob", "bash", "apply_patch"].map((tool, index) =>
      event(`other-${index}`, "tool.execution_start", { toolCallId: `other-${index}`, toolName: tool, arguments: {} })),
  ], "14");
  await session("beta", [
    { ...event("child", "subagent.started", { toolCallId: "spawn", agentName: "researcher" }), agentId: "child" },
    { ...usage("new", 2000, "new-model"), agentId: "child" },
    event("skill", "skill.invoked", { name: "research", content: "Synthetic research workflow" }),
  ]);
  await session("gamma", [usage("old", 900, "old-model", "14")], "14");
  for (let i = 0; i < 22; i++) await session(`extra-${i}`, [
    { ...usage("usage", 10, "small-model"), timestamp: `2026-11-15T${16 + i % 8}:00:00Z` },
  ]);
  await session("archive", [usage("old", 700, "archive-model")]);
  await utimes(join(root, "archive", "events.jsonl"), new Date("2020-01-01"), new Date("2020-01-01"));
  const panel = { store: createStore(root), selected: null, view: "activity", limits: LIMITS };
  const server = await startServer(panel, async (code) => { throw new Error(code); });
  t.after(() => server.close());
  const browser = await chromium.launch({
    headless: true, ...(process.env.SESSION_LENS_BROWSER_EXECUTABLE ? { executablePath: process.env.SESSION_LENS_BROWSER_EXECUTABLE } : {}),
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, timezoneId: "America/Los_Angeles", colorScheme: "light", reducedMotion: "reduce",
  });
  const page = await context.newPage(), errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (!request.url().startsWith(server.url)) external.push(request.url()); });
  await page.clock.install({ time: new Date("2026-11-16T00:00:00Z") });
  await page.goto(server.url);
  await page.locator(".activity-progress").getByText("Scanned 25 of 25 session logs").waitFor();
  assert.equal(await page.getByRole("button", { name: "Today", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#tabs").isVisible(), false);
  assert.equal(await page.getByRole("heading", { name: "Hourly usage", exact: true }).count(), 1);
  assert.equal(await page.locator(".activity-day[data-hour]").count(), 24);
  assert.match(await page.locator(".activity-range-info").textContent(), /1 older log excluded/);
  const value = async (label) => page.locator(".metric").filter({ has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd").textContent();
  assert.equal(await value("Input tokens"), "3,220");
  assert.equal(await value("Sessions"), "24");
  assert.equal(await page.getByText("old-model", { exact: true }).count(), 0);
  const side = page.locator(".activity-middle");
  assert.equal(await side.locator(".primitive-skills").isVisible(), true);
  assert.equal(await side.locator(".primitive-mcps").isVisible(), true);
  assert.equal(await side.locator(".other-tools").getAttribute("open"), null);
  const badge = side.locator(".primitive-mcps .primitive-sessions").first();
  assert.equal(await badge.getAttribute("aria-label"), "1 session");
  assert.equal(await badge.locator("svg[aria-hidden=true]").count(), 1);
  const rowHeight = await side.locator(".primitive-mcps .primitive-row").first().evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(rowHeight <= 26, `MCP name, count and session link should fit one row: ${rowHeight}`);
  await side.locator(".primitive-skills").getByRole("button", { name: "release-notes", exact: true }).click();
  assert.equal(await page.locator(".activity-session-name").count(), 1);
  assert.equal(await value("Input tokens"), "3,220");
  await page.getByRole("button", { name: "Billing UI", exact: true }).click();
  await page.locator(".session-primitives").waitFor();
  assert.match(await page.locator(".session-primitives .primitive-selection").textContent(), /release-notes/);
  assert.equal(await page.locator(".session-primitives .primitive-skills").getByRole("button", { name: "release-notes", exact: true }).count(), 1);
  assert.equal(await page.locator(".session-primitives .primitive-mcps").getByRole("button", { name: "GitHub", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await page.getByRole("group", { name: "Usage attribution scope" }).getByRole("button", { name: "Selected agent", exact: true }).click();
  assert.equal(await page.locator(".session-primitives .primitive-skills").getByRole("button", { name: "release-notes", exact: true }).count(), 1);
  if (process.env.SESSION_LENS_SCREENSHOTS) {
    await page.screenshot({ path: join(process.env.SESSION_LENS_SCREENSHOTS, "session-lens-context.png") });
  }
  await page.getByRole("button", { name: "Activity · Today", exact: true }).click();
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await side.locator(".primitive-mcps").getByRole("button", { name: "GitHub", exact: true }).click();
  assert.equal(await page.locator(".activity-session-name").count(), 1);
  await side.locator(".mcp-tools > summary").click();
  await side.locator(".other-tools > summary").click();
  const disclosureSizes = await side.locator(".mcp-tools > summary, .other-tools > summary").evaluateAll((nodes) => nodes.map((node) => ({
    fontSize: getComputedStyle(node).fontSize, height: node.getBoundingClientRect().height,
  })));
  assert.ok(disclosureSizes.every((size) => size.fontSize === "11px" && size.height <= 26), JSON.stringify(disclosureSizes));
  const toolSizes = await side.locator(".mcp-tools .primitive-name, .other-tools .primitive-name").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
  assert.ok(toolSizes.every((size) => size === "12px"), JSON.stringify(toolSizes));
  assert.equal(await side.locator(".mcp-tools .primitive-row").count(), 6);
  assert.ok((await side.locator(".other-tools .tool-list").boundingBox()).height <= 156);
  assert.equal(await side.locator(".mcp-tools").getByRole("button", { name: "list_pull_requests", exact: true }).getAttribute("title"), "list_pull_requests");
  if (process.env.SESSION_LENS_SCREENSHOTS) {
    await page.screenshot({ path: join(process.env.SESSION_LENS_SCREENSHOTS, "session-lens-tools-expanded.png") });
  }
  await side.locator(".other-tools > summary").click();
  await side.locator(".mcp-tools").getByRole("button", { name: "find", exact: true }).click();
  assert.match(await page.locator(".activity-session-list .primitive-selection").textContent(), /GitHub \/ find/);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await side.locator(".primitive-models").getByRole("button", { name: "Subagent 1", exact: true }).click();
  assert.equal(await page.locator(".activity-session-name").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Session beta", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Clear filter", exact: true }).click();
  await page.getByRole("searchbox", { name: "Filter sessions or models" }).fill("alpha");
  const row = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Billing UI", exact: true }) });
  assert.match(await row.innerText(), /1,000/);
  assert.doesNotMatch(await row.innerText(), /10K|10,000|9,000/);
  await page.getByRole("button", { name: "Yesterday", exact: true }).click();
  assert.equal(await value("Input tokens"), "9,900");
  await page.getByRole("button", { name: "Billing UI", exact: true }).click();
  await page.locator(".context-workbench").waitFor();
  assert.match(await page.locator(".browser-controls select").inputValue(), /request-/);
  assert.equal(await page.locator(".context-trend [data-in-range=true][aria-pressed=true]").count(), 1);
  await page.getByRole("button", { name: "Activity · Yesterday", exact: true }).click();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  assert.equal(await value("Input tokens"), "13.1K");
  await page.getByRole("button", { name: "Billing UI", exact: true }).click();
  await page.locator("#tabs").waitFor({ state: "visible" });
  assert.equal(await page.locator("#tabs").isVisible(), true);
  assert.match(await page.locator("#session-scope").textContent(), /Last 7 days.*Full history/);
  assert.equal(await page.locator(".context-workbench").isVisible(), true);
  await page.getByRole("button", { name: "Activity · Last 7 days", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "7 days", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("searchbox", { name: "Filter sessions or models" }).inputValue(), "alpha");
  assert.equal(await value("Input tokens"), "13.1K");
  await page.getByRole("button", { name: "Custom", exact: true }).click();
  await page.getByLabel("From", { exact: true }).fill("2026-11-15");
  await page.getByLabel("To", { exact: true }).fill("2026-11-15");
  assert.equal(await value("Input tokens"), "3,220");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let seen;
  const intercepted = new Promise((resolve) => { seen = resolve; });
  await page.route("**/api/overview?**", async (route) => { seen(); await gate; await route.continue(); });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await intercepted;
  assert.equal(await value("Input tokens"), "3,220");
  assert.match(await page.locator(".activity-progress").textContent(), /previous snapshot/);
  release();
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  await page.locator(".activity-progress").getByText("Scanned 25 of 25 session logs").waitFor();
  await page.unroute("**/api/overview?**");
  assert.equal(await page.getByLabel("From", { exact: true }).inputValue(), "2026-11-15");
  assert.equal(await page.getByLabel("To", { exact: true }).inputValue(), "2026-11-15");
  assert.equal(await value("Input tokens"), "3,220");
  await page.getByLabel("From", { exact: true }).fill("2026-11-16");
  assert.equal(await page.getByRole("alert").filter({ hasText: "start date" }).isVisible(), true);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByRole("searchbox", { name: "Filter sessions or models" }).fill("");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const pageTwo = await page.locator(".activity-session-name button").allTextContents();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#refresh").disabled);
  await page.locator(".activity-progress").getByText("Scanned 25 of 25 session logs").waitFor();
  assert.deepEqual(await page.locator(".activity-session-name button").allTextContents(), pageTwo);
  const target = page.locator(".activity-session-name button").first();
  await target.scrollIntoViewIfNeeded();
  const beforeScroll = await page.evaluate(() => scrollY);
  await target.click();
  await page.locator("#session-breadcrumb").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Activity · Today", exact: true }).click();
  await page.locator(".activity-heading").waitFor();
  await page.waitForFunction((y) => Math.abs(scrollY - y) < 3, beforeScroll);
  assert.deepEqual(await page.locator(".activity-session-name button").allTextContents(), pageTwo);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.locator(".view-options > summary").click();
  await page.getByLabel("Limit history to 30 days", { exact: true }).uncheck();
  await page.locator(".activity-progress").getByText("Scanned 26 of 26 session logs").waitFor();
  assert.equal(await value("Input tokens"), "3,920");
  await page.getByLabel("Limit history to 30 days", { exact: true }).check();
  await page.locator(".activity-progress").getByText("Scanned 25 of 25 session logs").waitFor();
  assert.equal(await value("Input tokens"), "3,220");
  await page.locator(".view-options > summary").click();
  await page.getByRole("button", { name: "7 days", exact: true }).click();
  await page.locator(".activity-day").last().click();
  assert.equal(await page.getByRole("heading", { name: "Hourly usage", exact: true }).count(), 1);
  assert.equal(await page.locator(".focus-chip").count(), 1);
  await page.locator(".focus-chip").click();
  assert.equal(await page.getByRole("heading", { name: "Daily usage", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal(await page.locator("#error:visible").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SESSION_LENS_SCREENSHOTS) {
    await page.screenshot({ path: join(process.env.SESSION_LENS_SCREENSHOTS, "session-lens-activity.png") });
  }
  await page.setViewportSize({ width: 960, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const headingHeights = await page.locator(".primitive-heading h3").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  assert.ok(headingHeights.every((height) => height < 20), JSON.stringify(headingHeights));
  await page.setViewportSize({ width: 420, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator("#refresh").getAttribute("aria-label"), "Refresh");
  assert.equal(await page.locator(".view-options > summary").getAttribute("aria-label"), "View options");
  if (process.env.SESSION_LENS_SCREENSHOTS) {
    await page.screenshot({ path: join(process.env.SESSION_LENS_SCREENSHOTS, "session-lens-activity-narrow.png") });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  if (process.env.SESSION_LENS_SCREENSHOTS) {
    await page.screenshot({ path: join(process.env.SESSION_LENS_SCREENSHOTS, "session-lens-activity-dark.png") });
  }
  // Direct links retain the per-session entry point.
  panel.selected = "alpha"; panel.view = "session";
  await page.reload();
  await page.locator(".context-workbench").waitFor();
  assert.equal(await page.locator("#tabs").isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
