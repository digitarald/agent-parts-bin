import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addToReadme, newPlugin, repositoryName } from "../scripts/new-plugin.mjs";
import { renameMarkdown } from "../scripts/rename-marketplace.mjs";
import { launcherOptions, specsForPlugins } from "../scripts/evals.mjs";
import { ownedPaths } from "../scripts/examples.mjs";
import { assertRemovable, removePlugins } from "../scripts/remove-plugin.mjs";
import { frontmatter } from "../scripts/catalog.mjs";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = (name, ...args) => spawnSync(process.execPath, [`scripts/${name}`, ...args], { cwd: root, encoding: "utf8", timeout: 60_000 });
// Every eval spec under evals/<plugin>/, as repository paths.
const readEvalsSync = () => readdirSync(join(root, "evals"), { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /(?:^|\.)eval\.ya?ml$/.test(entry.name))
  .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(/[\\/]/).join("/"));

test("new plugins join the README's plugin table and install commands", () => {
  const readme = [
    "<!-- plugin-table -->", "| Plugin | Try it | Teaches |", "|---|---|---|", "| _None yet._ | | |", "",
    "```sh", "copilot plugin marketplace add me/plugins", "copilot plugin marketplace browse mine", "```",
  ].join("\n");
  const once = addToReadme(readme, { name: "alpha", marketplace: "mine", description: "Does a | b.", tryIt: "Try alpha" });
  assert.match(once, /\| \[alpha\]\(plugins\/alpha\/\) \| Try alpha \| Does a \\\| b\. \|\n\n/);
  assert.doesNotMatch(once, /None yet/);
  assert.match(once, /browse mine\ncopilot plugin install alpha@mine\n```/);
  const twice = addToReadme(once, { name: "beta", marketplace: "mine", description: "Beta.", tryIt: "Try beta" });
  assert.match(twice, /\[alpha\][^\n]*\n\| \[beta\]/);
  assert.match(twice, /install alpha@mine\ncopilot plugin install beta@mine/);
  assert.equal(addToReadme("# Rewritten README\n", { name: "x", marketplace: "m", description: "d", tryIt: "t" }), "# Rewritten README\n");
});

test("the repository name comes from package.json in any common form", () => {
  for (const repository of ["github:me/plugins", "https://github.com/me/plugins", "https://github.com/me/plugins.git",
    { url: "git+https://github.com/me/plugins.git" }, { url: "git@github.com:me/plugins.git" }]) {
    assert.equal(repositoryName({ repository }), "me/plugins", JSON.stringify(repository));
  }
  assert.equal(repositoryName({}), undefined);
});

test("renaming rewrites install commands and placeholders, and drops template-only notes", () => {
  const from = { name: "plugin-marketplace-starter", repo: "github/plugin-marketplace-starter" };
  const to = { name: "jdoe-skills", repo: "jdoe/skills" };
  const readme = renameMarkdown([
    "# Plugin marketplace starter", "",
    "copilot plugin marketplace add github/plugin-marketplace-starter",
    "copilot plugin marketplace browse plugin-marketplace-starter",
    "copilot plugin install bug-report@plugin-marketplace-starter",
    "<!-- template-only -->", "This repository is currently private.", "<!-- /template-only -->",
    "The canvas ID marketplace-starter-brainstorm stays.",
  ].join("\n"), { from, to });
  assert.equal(readme, [
    "# Jdoe Skills", "",
    "copilot plugin marketplace add jdoe/skills",
    "copilot plugin marketplace browse jdoe-skills",
    "copilot plugin install bug-report@jdoe-skills",
    "The canvas ID marketplace-starter-brainstorm stays.",
  ].join("\n"));
  const plugin = renameMarkdown([
    "```sh", "copilot plugin marketplace add OWNER/REPO", "copilot plugin install bug-report@MARKETPLACE", "```", "",
    "Replace `OWNER/REPO` with the GitHub repository that hosts this marketplace",
    "and `MARKETPLACE` with the `name` in its `marketplace.json`. See",
    "[Install plugins](../../README.md#install-plugins) for VS Code.",
  ].join("\n"), { from, to });
  assert.equal(plugin, [
    "```sh", "copilot plugin marketplace add jdoe/skills", "copilot plugin install bug-report@jdoe-skills", "```", "",
    "See", "[Install plugins](../../README.md#install-plugins) for VS Code.",
  ].join("\n"));
});

test("--plugin selects every spec for a plugin, including nested ones and tagged cases", () => {
  const spec = (path, ...assets) => ({ path: join(root, "evals", path), spec: { stimuli: [{ name: path, tags: { assets } }] } });
  const specs = [
    spec("review/eval.yaml", "skill:review/review"),
    spec("review/agent/eval.yaml", "agent:review/reviewer"),
    spec("shared/eval.yaml", "skill:other/other", "mcp:review/server/tool"),
    spec("reviewer-extra/eval.yaml", "skill:reviewer-extra/x"),
  ];
  assert.deepEqual(specsForPlugins(["review"], specs, root).map((item) => item.spec.stimuli[0].name),
    ["review/eval.yaml", "review/agent/eval.yaml", "shared/eval.yaml"]);
  assert.throws(() => specsForPlugins(["missing"], specs, root), /No eval specs found for plugin missing/);
  assert.deepEqual(launcherOptions(["--plugin", "a", "--plugin=b", "--list", "--model", "x"]), { plugins: ["a", "b"], list: true, help: false, rest: ["--model", "x"] });
  assert.throws(() => launcherOptions(["--plugin"]), /needs a plugin name/);
});

test("the launcher lists a selection for free, and every script explains itself", () => {
  const listed = script("evals.mjs", "eval", "--suite", "smoke", "--list");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^Would run \d+ cases? from \d+ specs?\.|^There are no eval specs yet/);
  if (listed.stdout.startsWith("Would run")) assert.match(listed.stdout, /node scripts\/evals\.mjs eval --suite smoke/);
  // With no selection, it's the full suite, and both printed commands work as shown.
  const all = script("evals.mjs", "eval", "--list", "--model", "gpt-5.4");
  assert.equal(all.status, 0, all.stderr);
  if (all.stdout.startsWith("Would run")) {
    assert.match(all.stdout, /node scripts\/evals\.mjs eval --suite full --model gpt-5\.4\n/);
    assert.match(all.stdout, /npm run eval:report -- --suite full\n/);
  }
  for (const [name, args, pattern] of [
    ["evals.mjs", ["--help"], /Usage: node scripts\/evals\.mjs/],
    ["eval-report.mjs", ["--help"], /Usage: npm run eval:report/],
    ["new-plugin.mjs", ["--help"], /--with hook/],
    ["remove-plugin.mjs", ["--help"], /--all/],
    ["rename-marketplace.mjs", ["--help"], /--repo <OWNER\/REPO>/],
    ["check-remotes.mjs", ["--help"], /uses the\s+network/],
  ]) {
    const result = script(name, ...args);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.match(result.stdout, pattern, name);
  }
  for (const [name, args, pattern] of [
    ["eval-report.mjs", ["--bogus"], /Unknown option '--bogus'\. Run npm run eval:report -- --help/],
    ["eval-report.mjs", ["--suite", "smoke", "--run-dir", "vally-results/not-a-run"], /results\.jsonl doesn't exist/],
    ["evals.mjs", ["frobnicate"], /Unknown command frobnicate/],
    ["new-plugin.mjs", ["x", "--with", "nope"], /Unknown --with value: nope/],
    ["new-plugin.mjs", ["x", "--no-skill"], /needs at least one asset/],
  ]) {
    const result = script(name, ...args);
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, pattern, name);
    assert.doesNotMatch(result.stderr, /\n\s+at /, `${name}: a plain message, not a stack trace`);
  }
});

test("support files named after a plugin belong to it, but not to a shorter name or the template", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-owned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ["evals/graders/bug.mjs", "evals/graders/bug-report.mjs", "evals/graders/common.mjs", "evals/support/bug-host.mjs",
    "test/bug.test.mjs", "test/bug-hook.test.mjs", "test/bug-report.test.mjs", "test/catalog.test.mjs", "evals/fixtures/bug/a.txt"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), "");
  }
  assert.deepEqual((await ownedPaths("bug", { directory, others: ["bug-report"] })).sort(), [
    "evals/bug", "evals/fixtures/bug", "evals/graders/bug.mjs", "evals/support/bug-host.mjs", "plugins/bug", "test/bug-hook.test.mjs", "test/bug.test.mjs",
  ]);
  assert.ok(!(await ownedPaths("catalog", { directory })).includes("test/catalog.test.mjs"));
  assert.ok(!(await ownedPaths("common", { directory })).includes("evals/graders/common.mjs"));
  // A bundled grader's source and build go with the plugin too.
  for (const file of ["evals/graders/src/bug.mjs", "evals/graders/dist/bug.mjs", "evals/graders/dist/THIRD_PARTY_NOTICES.txt"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), "");
  }
  const owned = await ownedPaths("bug", { directory, others: ["bug-report"] });
  assert.ok(owned.includes("evals/graders/src/bug.mjs") && owned.includes("evals/graders/dist/bug.mjs"));
  assert.ok(!owned.includes("evals/graders/dist/THIRD_PARTY_NOTICES.txt"));
});

test("removal refuses anything that isn't a plugin name, before it touches the file system", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-remove-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "marketplace.json"), JSON.stringify({ name: "fixture", owner: { name: "Test" }, plugins: [] }));
  for (const file of ["docs/keep.md", "scripts/keep.mjs", "plugins/real/plugin.json"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), "sentinel");
  }
  const outside = resolve(directory, "..");
  for (const name of ["../docs", "../scripts", "..\\docs", "plugins/../docs", "..", ".", "", "Docs", "a--b", outside, resolve(directory, "docs"), "x".repeat(65)]) {
    for (const dryRun of [true, false]) {
      await assert.rejects(removePlugins([name], { directory, dryRun }), /isn't a plugin name\. Plugin names are lowercase.*Nothing was removed/, JSON.stringify(name));
    }
  }
  // One bad name stops the whole request, even with a valid one beside it.
  await assert.rejects(removePlugins(["real", "../docs"], { directory }), /isn't a plugin name/);
  for (const file of ["docs/keep.md", "scripts/keep.mjs", "plugins/real/plugin.json"]) assert.ok(existsSync(join(directory, file)), file);
  await assert.rejects(removePlugins(["ghost"], { directory }), /No plugin named ghost/);
  // Deletion is limited to plugins/, evals/, test/, and the examples guide.
  for (const path of ["plugins/real", "evals/real", "test/real.test.mjs", "docs/examples.md"]) assert.doesNotThrow(() => assertRemovable(directory, path), path);
  for (const path of ["plugins", "plugins/../docs", "../plugins/x", "docs/keep.md", "scripts/x.mjs", outside]) {
    assert.throws(() => assertRemovable(directory, path), /Refusing to remove/, path);
  }
  const cli = script("remove-plugin.mjs", "../scripts", "--dry-run");
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /"\.\.\/scripts" isn't a plugin name/);
  assert.doesNotMatch(cli.stdout, /Would remove/);
});

test("a long plugin name with an agent is refused before anything is written, and the 53-character limit works", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "starter-long-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = { name: "fixture", owner: { name: "Test" }, plugins: [] };
  await writeFile(join(directory, "marketplace.json"), JSON.stringify(catalog));
  await mkdir(join(directory, ".github/copilot"), { recursive: true });
  await writeFile(join(directory, ".github/copilot/settings.json"), JSON.stringify({ enabledPlugins: {} }));
  await writeFile(join(directory, ".vally.yaml"), "paths:\n  skills: []\n");
  const tooLong = "a".repeat(54);
  await assert.rejects(newPlugin(tooLong, { components: ["agent"], directory }), /at most 53 characters/);
  assert.ok(!existsSync(join(directory, "plugins", tooLong)));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "marketplace.json"), "utf8")), catalog);
  const name = "b".repeat(53);
  const { options } = await newPlugin(name, { components: ["agent"], directory });
  // The root LICENSE covers every plugin, so new-plugin doesn't scaffold one.
  assert.ok(!existsSync(join(directory, "plugins", name, "LICENSE")));
  assert.ok(existsSync(join(directory, "plugins", name, "CHANGELOG.md")));
  const profile = await readFile(join(directory, "plugins", name, "com.github.copilot/agents", `${options.agent}.agent.md`), "utf8");
  assert.equal(frontmatter(profile, "agent").name, `${name}-specialist`);
  assert.equal(frontmatter(await readFile(join(directory, "plugins", name, "skills", name, "SKILL.md"), "utf8"), "skill").name, name);
  // Every case, including the negative control, sees the agent profile.
  const spec = parse(await readFile(join(directory, "evals", name, "eval.yaml"), "utf8"));
  assert.deepEqual(spec.agent_environment.files, [{ src: `../../plugins/${name}/com.github.copilot/agents/${name}-specialist.agent.md`, dest: `.github/agents/${name}-specialist.agent.md` }]);
  assert.ok(spec.stimuli.every((stimulus) => !stimulus.agent_environment?.files));
  // A plugin name can still use all 64 characters without an agent.
  await newPlugin("c".repeat(64), { directory });
});

test("lint --plugin lints every selected spec and the plugin's skills", (t) => {
  const specs = readEvalsSync();
  const nested = Object.entries(Object.groupBy(specs, (path) => path.split("/")[1])).find(([, paths]) => paths.length > 1);
  if (!nested) return t.skip("no plugin with more than one eval spec");
  const [plugin, paths] = nested;
  const result = script("evals.mjs", "lint", "--plugin", plugin);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const output = result.stdout.replaceAll("\\", "/");
  for (const path of paths) assert.match(output, new RegExp(`${path.replaceAll(".", "\\.")} is valid`), path);
  if (existsSync(join(root, "plugins", plugin, "skills"))) assert.match(output, /skill\(s\) linted/);
  const singles = Object.entries(Object.groupBy(specs, (path) => path.split("/")[1])).filter(([, items]) => items.length === 1).slice(0, 2);
  if (singles.length === 2) {
    const both = script("evals.mjs", "lint", ...singles.flatMap(([name]) => ["--plugin", name]));
    assert.equal(both.status, 0, `${both.stdout}\n${both.stderr}`);
    for (const [, [path]] of singles) assert.match(both.stdout.replaceAll("\\", "/"), new RegExp(`${path.replaceAll(".", "\\.")} is valid`), path);
  }
});

test("npm run verify explains missing dependencies instead of crashing", () => {
  // Runs a copy of the first verify step from a directory with no node_modules.
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { cpSync, mkdirSync, mkdtempSync } from "node:fs"; import { join } from "node:path"; import { tmpdir } from "node:os"; import { spawnSync } from "node:child_process";
    const dir = mkdtempSync(join(tmpdir(), "starter-nodeps-"));
    mkdirSync(join(dir, "scripts"));
    cpSync(${JSON.stringify(join(root, "scripts/typecheck.mjs"))}, join(dir, "scripts/typecheck.mjs"));
    cpSync(${JSON.stringify(join(root, "scripts/entrypoint.mjs"))}, join(dir, "scripts/entrypoint.mjs"));
    const result = spawnSync(process.execPath, [join(dir, "scripts/typecheck.mjs")], { cwd: dir, encoding: "utf8" });
    process.stdout.write(JSON.stringify({ status: result.status, stderr: result.stderr }));
  `], { encoding: "utf8" });
  const result = JSON.parse(output);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Dependencies aren't installed\. Run npm ci first/);
});
