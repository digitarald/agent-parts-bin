import test from "node:test";
import assert from "node:assert/strict";
import { checkRemote } from "../scripts/check-remotes.mjs";

// A fake GitHub API, so these checks never touch the network.
const sha = "a".repeat(40);
const next = "b".repeat(40);
const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
function fakeApi({ manifest = { $schema: schema, name: "tool", version: "1.0.0" }, at = "plugin/plugin.json", also = {}, refSha = sha, compare = "identical", latest = "v1.0.0", missing = [] } = {}) {
  return async (path) => {
    if (missing.some((part) => path.includes(part))) return { status: 404, body: { message: "Not Found" } };
    if (path === "/repos/o/r") return { status: 200, body: {} };
    if (path === `/repos/o/r/commits/${sha}`) return { status: 200, body: { sha } };
    if (path.startsWith("/repos/o/r/commits/")) return { status: 200, body: { sha: refSha } };
    const file = (data) => ({ status: 200, body: { content: Buffer.from(JSON.stringify(data)).toString("base64") } });
    if (path === `/repos/o/r/contents/${at}?ref=${sha}`) return file(manifest);
    for (const [other, data] of Object.entries(also)) if (path === `/repos/o/r/contents/${other}?ref=${sha}`) return file(data);
    if (path.startsWith("/repos/o/r/contents/")) return { status: 404, body: {} };
    if (path.startsWith("/repos/o/r/compare/")) return { status: 200, body: { status: compare, ahead_by: 3, behind_by: 1 } };
    if (path === "/repos/o/r/releases/latest") return latest ? { status: 200, body: { tag_name: latest } } : { status: 404, body: {} };
    throw new Error(`Unexpected request ${path}`);
  };
}
const entry = (source = {}, extra = {}) => ({ name: "tool", version: "1.0.0", source: { source: "github", repo: "o/r", path: "plugin", ref: "v1.0.0", sha, ...source }, ...extra });

test("a correct pin passes with no notes", async () => {
  assert.deepEqual(await checkRemote(entry(), fakeApi()), { name: "tool", errors: [], notes: [] });
});

test("a missing repository, sha, or manifest, or a wrong name or version, is an error", async () => {
  assert.match((await checkRemote(entry(), fakeApi({ missing: ["/repos/o/r"] }))).errors[0], /doesn't exist, or your token can't read it/);
  assert.match((await checkRemote(entry(), fakeApi({ missing: [`commits/${sha}`] }))).errors[0], /isn't a commit/);
  assert.match((await checkRemote(entry({ path: "elsewhere" }), fakeApi())).errors[0], /no plugin.json under "elsewhere".*omit it when plugin.json is at the root/);
  assert.match((await checkRemote(entry(), fakeApi({ manifest: { $schema: schema, name: "tool-plugin", version: "1.0.0" } }))).errors[0], /named "tool-plugin", but the catalog entry is "tool"/);
  assert.match((await checkRemote(entry(), fakeApi({ manifest: { $schema: schema, name: "tool", version: "2.0.0" } }))).errors[0], /says version 1.0.0.*says 2.0.0/);
  assert.match((await checkRemote(entry({ ref: "gone" }), fakeApi({ missing: ["commits/gone"] }))).errors[0], /ref gone doesn't exist/);
});

test("a root plugin.json works without a path, and legacy manifest locations are found with a note", async () => {
  assert.deepEqual(await checkRemote(entry({ path: undefined }), fakeApi({ at: "plugin.json" })), { name: "tool", errors: [], notes: [] });
  for (const at of ["plugin/.plugin/plugin.json", "plugin/.github/plugin/plugin.json", "plugin/.claude-plugin/plugin.json"]) {
    const legacy = await checkRemote(entry(), fakeApi({ at, manifest: { name: "tool", version: "1.0.0" } }));
    assert.deepEqual(legacy.errors, [], at);
    assert.match(legacy.notes[0], new RegExp(`legacy plugin manifest \\(${at.replaceAll(".", "\\.")}\\)`), at);
  }
  // Copilot CLI's legacy order puts .plugin/plugin.json before a root plugin.json
  // without an Agent Plugins $schema; one with that $schema wins.
  const order = { "plugin/.plugin/plugin.json": { name: "tool", version: "1.0.0" } };
  assert.match((await checkRemote(entry(), fakeApi({ manifest: { name: "other", version: "1.0.0" }, also: order }))).notes[0], /\.plugin\/plugin\.json/);
  assert.deepEqual((await checkRemote(entry(), fakeApi({ also: { "plugin/.plugin/plugin.json": { name: "other" } } }))).errors, []);
});

test("moved refs and newer releases are notes, not errors", async () => {
  const ahead = await checkRemote(entry({ ref: "main" }), fakeApi({ refSha: next, compare: "ahead" }));
  assert.deepEqual(ahead.errors, []);
  assert.match(ahead.notes[0], /ref main is now 3 commits ahead of the pinned sha/);
  assert.match(ahead.notes[1], /latest release in o\/r is v1\.0\.0; the pin is main/);
  assert.match((await checkRemote(entry(), fakeApi({ refSha: next, compare: "behind" }))).notes[0], /1 commit behind the pinned sha/);
  assert.match((await checkRemote(entry(), fakeApi({ refSha: next, compare: "diverged" }))).notes[0], /has diverged/);
  assert.match((await checkRemote(entry(), fakeApi({ latest: "v2.0.0" }))).notes[0], /latest release in o\/r is v2\.0\.0; the pin is v1\.0\.0/);
});
