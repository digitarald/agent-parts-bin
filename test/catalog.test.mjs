import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readCatalog, partitionCatalog, remoteWarnings, validateRemoteSource } from "../scripts/catalog.mjs";
import { discoverAssets, checkCoverage, root } from "../scripts/validate-evals.mjs";

test("the catalog separates local plugins from pinned, opt-in remote references", async () => {
  const { catalog, localPlugins, remotePlugins } = await readCatalog(root);
  assert.equal(localPlugins.length + remotePlugins.length, catalog.plugins.length);
  for (const remote of remotePlugins) assert.doesNotThrow(() => validateRemoteSource(remote.source, remote.name));
  const local = { name: "dup", source: "./plugins/dup" };
  const sha = "a".repeat(40);
  assert.throws(() => partitionCatalog({ ...catalog, plugins: [local, local] }), /Duplicate/);
  assert.throws(() => partitionCatalog({ ...catalog, plugins: [{ name: "escape", source: "./plugins/../outside" }] }), /escape: Local source/);
  assert.throws(() => partitionCatalog({ ...catalog, plugins: [{ name: "remote", source: { source: "github", repo: "o/r", sha }, version: "" }] }), /version/);
  assert.deepEqual(remoteWarnings({ name: "loose", source: { source: "github", repo: "o/r", sha } }).length, 1);
});

test("an empty catalog is valid, and catalog errors are plain sentences", () => {
  const empty = partitionCatalog({ name: "empty", owner: { name: "Me" }, plugins: [] });
  assert.deepEqual([empty.localPlugins, empty.remotePlugins], [[], []]);
  assert.throws(() => partitionCatalog({ name: "Bad Name", owner: { name: "Me" }, plugins: [] }), /must be lowercase/);
  assert.throws(() => partitionCatalog({ name: "ok", plugins: [] }), /owner\.name/);
  assert.throws(() => partitionCatalog({ name: "ok", owner: { name: "Me" } }), /plugins must be a list/);
  assert.throws(() => partitionCatalog({ name: "ok", owner: { name: "Me" }, plugins: [{ name: "Bad" }] }), /plugins\[0\]: name "Bad"/);
});

test("remote references must pin a full sha, and errors name the entry", () => {
  const sha = "a".repeat(40);
  for (const source of [
    { source: "github", repo: "example/plugins", path: "packages/plugin", sha },
    { source: "github", repo: "example/plugin", ref: "v1.0.0", sha },
    { source: "github", repo: "example/plugin", sha },
  ]) assert.doesNotThrow(() => validateRemoteSource(source, "fixture"));
  for (const source of [
    null, [], { source: "github", sha }, { source: "url", repo: "example/plugin", sha },
    { source: "github", repo: "https://github.com/example/plugin", sha },
    { source: "github", repo: "example/plugin", path: "../plugin", sha },
    { source: "github", repo: "example/plugin", path: "./plugin", sha },
    { source: "github", repo: "example/plugin", path: ".", sha },
    { source: "github", repo: "example/plugin", path: "C:\\plugin", sha },
    { source: "github", repo: "example/plugin", ref: " ", sha },
    { source: "github", repo: "example/plugin", sha: "main" },
    { source: "github", repo: "example/plugin", sha: "abc1234" },
    { source: "github", repo: "example/plugin", ref: "main" },
    { source: "github", repo: "example/plugin", token: "not-supported", sha },
  ]) assert.throws(() => validateRemoteSource(source, "fixture"), /fixture: /);
  assert.throws(() => validateRemoteSource({ source: "github", repo: "o/r", ref: "main" }, "anarlog"), /anarlog: pin "sha".*gh api repos\/OWNER\/REPO\/commits\/REF/);
  assert.throws(() => validateRemoteSource({ source: "github", repo: "o/r", path: "./sub", sha }, "anarlog"), /anarlog: "path" must be.*Omit "path"/);
});

test("new custom agents require actual staged profiles, delegation, and subagent outcome assertions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-agent-coverage-"));
  try {
    const path = resolve(directory, "plugins/review/com.github.copilot/agents/reviewer.agent.md");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "---\nname: reviewer\ndescription: A read-only reviewer.\n---\nReview supplied source.\n");
    await writeFile(resolve(directory, "marketplace.json"), JSON.stringify({
      name: "agent-fixture", owner: { name: "Test" },
      plugins: [{ name: "review", source: "./plugins/review" }],
    }));
    const assets = await discoverAssets(directory);
    assert.equal(assets[0].id, "agent:review/reviewer");
    const specs = [{ path: resolve(directory, "evals/review/eval.yaml"), spec: {
      agent_environment: { files: [{ src: "../../plugins/review/com.github.copilot/agents/reviewer.agent.md", dest: ".github/agents/reviewer.agent.md" }] },
      stimuli: [
        { name: "uses-reviewer", tags: { assets: assets[0].id, control: "positive", suite: "smoke" }, graders: [
          { type: "tool-calls", config: { required: [{ name: "^task$", args: { agent_type: "^reviewer$" } }] } },
          { type: "output-matches", scope: "subagent", config: { pattern: "finding" } },
        ] },
        { name: "negative", tags: { assets: assets[0].id, control: "negative" }, graders: [{ type: "output-contains", config: { substring: "No actionable findings." } }] },
      ],
    } }];
    assert.equal(checkCoverage(assets, specs), 2);
    const unstaged = structuredClone(specs);
    unstaged[0].spec.agent_environment.files = [];
    assert.throws(() => checkCoverage(assets, unstaged), /stage the actual agent/);
    const notInvoked = structuredClone(specs);
    notInvoked[0].spec.stimuli[0].graders.shift();
    assert.throws(() => checkCoverage(assets, notInvoked), /assert delegation/);
    const parentOnly = structuredClone(specs);
    delete parentOnly[0].spec.stimuli[0].graders[1].scope;
    assert.throws(() => checkCoverage(assets, parentOnly), /subagent's behavior/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("any new hook or extension gets generic coverage rules, not the examples' specific ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-generic-coverage-"));
  try {
    const hookPlugin = resolve(directory, "plugins/lint-on-save");
    await mkdir(resolve(hookPlugin, "com.github.copilot/hooks"), { recursive: true });
    await writeFile(resolve(hookPlugin, "com.github.copilot/hooks/hooks.json"), JSON.stringify({ version: 1, hooks: { postToolUse: [] } }));
    const panelPlugin = resolve(directory, "plugins/panel");
    await mkdir(resolve(panelPlugin, "com.github.copilot/extensions/board"), { recursive: true });
    await writeFile(resolve(panelPlugin, "com.github.copilot/extensions/board/extension.mjs"), "");
    await writeFile(resolve(directory, "marketplace.json"), JSON.stringify({
      name: "generic-fixture", owner: { name: "Test" },
      plugins: [{ name: "lint-on-save", source: "./plugins/lint-on-save" }, { name: "panel", source: "./plugins/panel" }],
    }));
    const assets = await discoverAssets(directory);
    assert.deepEqual(assets.map((asset) => asset.id), ["hook:lint-on-save/postToolUse", "extension:panel/board"]);
    const specs = [{ path: resolve(directory, "evals/custom/eval.yaml"), spec: { stimuli: [
      { name: "hook-runs", agent_environment: { env: { STARTER_PLUGIN_DIRS: "plugins/other, plugins/lint-on-save" } },
        tags: { assets: assets[0].id, control: "positive", suite: "smoke" },
        graders: [{ type: "tool-calls", config: { required: [{ name: "^apply_patch$", result: "lint-on-save: " }] } }] },
      { name: "hook-skips", tags: { assets: assets[0].id, control: "negative" }, graders: [{ type: "diff-empty" }, { type: "output-contains", config: { substring: "ok" } }] },
      { name: "panel-works", agent_environment: { mcpServers: { "panel-host": { type: "stdio", command: "node", args: ["host.mjs"] } } },
        tags: { assets: assets[1].id, control: "positive", suite: "smoke", boundary: "headless-sdk-contract" },
        graders: [{ type: "program", config: { program: "node", args: [".grading/panel.mjs"] } }] },
      { name: "panel-skips", tags: { assets: assets[1].id, control: "negative" }, graders: [{ type: "tool-calls", config: { disallowed: ["open_canvas"] } }] },
    ] } }];
    assert.equal(checkCoverage(assets, specs, { directory }), 4);
    const unmounted = structuredClone(specs);
    delete unmounted[0].spec.stimuli[0].agent_environment;
    assert.throws(() => checkCoverage(assets, unmounted, { directory }), /STARTER_PLUGIN_DIRS/);
    // Evidence must come from the hook itself: its "<plugin>:" diagnostic or a program grader.
    for (const graders of [
      [{ type: "output-contains", config: { substring: "linted" } }],
      [{ type: "file-matches", config: { path: "a.js", pattern: "console\\.log" } }],
      [{ type: "tool-calls", config: { required: [{ name: "^apply_patch$", result: "success" }] } }],
      [{ type: "tool-calls", config: { required: ["^apply_patch$"] } }],
    ]) {
      const weak = structuredClone(specs);
      weak[0].spec.stimuli[0].graders = graders;
      assert.throws(() => checkCoverage(assets, weak, { directory }), /prove the hook ran|isn't outcome coverage/, JSON.stringify(graders));
    }
    for (const graders of [
      [{ type: "output-matches", config: { pattern: "lint-on-save: .*console" } }],
      [{ type: "output-contains", config: { substring: "lint-on-save: line 2" } }],
      [{ type: "file-matches", config: { path: "lint.log", pattern: "lint-on-save:" } }],
      [{ type: "program", config: { program: "node", args: [".grading/lint.mjs"] } }],
    ]) {
      const honest = structuredClone(specs);
      honest[0].spec.stimuli[0].graders = graders;
      assert.equal(checkCoverage(assets, honest, { directory }), 4, JSON.stringify(graders));
    }
    const unlabeled = structuredClone(specs);
    delete unlabeled[0].spec.stimuli[2].tags.boundary;
    assert.throws(() => checkCoverage(assets, unlabeled, { directory }), /tags\.boundary/);
    const noTransport = structuredClone(specs);
    delete noTransport[0].spec.stimuli[2].agent_environment;
    assert.throws(() => checkCoverage(assets, noTransport, { directory }), /transport/);
    const ungraded = structuredClone(specs);
    ungraded[0].spec.stimuli[2].graders = [{ type: "output-contains", config: { substring: "board" } }];
    assert.throws(() => checkCoverage(assets, ungraded, { directory }), /program grader/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
