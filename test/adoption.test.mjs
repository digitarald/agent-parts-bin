import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { root } from "../scripts/validate-evals.mjs";
import { examples } from "../scripts/examples.mjs";
import { pruneMarkdown } from "../scripts/remove-plugin.mjs";

// Never copied into a scratch repository: dependencies are linked, and results,
// eval state, and isolated Copilot homes don't belong to the template.
const skipped = new Set([".git", "node_modules", "vally-results", ".vally", ".copilot-home"]);
// Tests that would recurse or install every plugin into a Copilot home; they
// run in the real checkout only.
const outerOnly = new Set(["adoption.test.mjs", "installation.test.mjs"]);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const present = Object.keys(examples).filter((name) => existsSync(resolve(root, "plugins", name)));

function run(directory, ...args) {
  return new Promise((done, fail) => {
    execFile(process.execPath, args, {
      cwd: directory, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, VALLY_TELEMETRY_OPTOUT: "1", NODE_TEST_CONTEXT: undefined },
    }, (error, stdout, stderr) => {
      if (error && error.code !== undefined && typeof error.code !== "number") fail(error);
      else done({ status: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function ok(directory, ...args) {
  const result = await run(directory, ...args);
  assert.equal(result.status, 0, `${args.join(" ")} failed in ${directory}:\n${result.stdout}\n${result.stderr}`);
  // Warnings go to stderr, so return both.
  return `${result.stdout}${result.stderr}`;
}

// Copies the repository one entry at a time, so it also works when the scratch
// directory is inside the checkout (for example, when TEMP points there).
async function copyTree(source, destination, exclude) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (skipped.has(entry.name) || from === exclude) continue;
    if (entry.isDirectory()) await copyTree(from, join(destination, entry.name), exclude);
    else if (entry.isFile()) await copyFile(from, join(destination, entry.name));
  }
}

async function scratchRepository(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "starter-adoption-")));
  t.after(async () => {
    // Remove the link itself first so cleanup can never reach the real node_modules.
    await unlink(join(directory, "node_modules")).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  await copyTree(await realpath(root), directory, directory);
  await symlink(resolve(root, "node_modules"), join(directory, "node_modules"), "junction");
  return directory;
}

// The same model-free checks as npm run verify, run inside a scratch copy.
async function verify(directory, { tests = true } = {}) {
  await ok(directory, "scripts/typecheck.mjs");
  const validated = await ok(directory, "scripts/validate.mjs");
  // node_modules is linked into the copy, so this also proves the committed
  // bundles don't depend on where node_modules lives.
  await ok(directory, "scripts/build.mjs", "--check");
  const coverage = await ok(directory, "scripts/validate-evals.mjs");
  await ok(directory, "scripts/evals.mjs", "lint");
  if (tests) {
    const files = (await readdir(join(directory, "test"))).filter((name) => name.endsWith(".test.mjs") && !outerOnly.has(name))
      .map((name) => `test/${name}`);
    const result = await run(directory, "--test", "--test-reporter=tap", ...files);
    const lines = result.stdout.split("\n");
    const failures = lines.flatMap((line, index) => /^\s*not ok/.test(line) ? lines.slice(index, index + 20) : []);
    assert.equal(result.status, 0, `Tests failed after customization:\n${failures.join("\n")}\n${result.stderr}`);
    assert.match(result.stdout, /# fail 0/);
  }
  return { validated, coverage };
}

const newPlugin = (directory, ...args) => ok(directory, "scripts/new-plugin.mjs", ...args);
const removeExamples = (directory, ...names) => ok(directory, "scripts/remove-plugin.mjs", "--example", ...names);

// Follows the README's "Make it yours" steps on a copy of this repository, as a
// team that already has its own plugins would: one named like an old test
// fixture, and a second MCP server next to the JSON example.
test("a team can rename the marketplace, drop examples and the remote entry, and add its own plugins", { timeout: 600_000 }, async (t) => {
  const directory = await scratchRepository(t);
  const fixture = `adoption-${randomBytes(3).toString("hex")}`;
  if (!existsSync(join(directory, "plugins/release-notes"))) {
    await newPlugin(directory, "release-notes");
    // The guide's chat-skill eval must pass the coverage check and strict lint as written.
    const example = (await readFile(join(directory, "docs/eval-authoring.md"), "utf8")).match(/```yaml\r?\n(name: release-notes\r?\n[\s\S]*?)```/)?.[1];
    assert.ok(example, "docs/eval-authoring.md should keep its release-notes example.");
    if (example) await writeFile(join(directory, "evals/release-notes/eval.yaml"), example);
  }
  await newPlugin(directory, `${fixture}-tools`, "--with", "mcp", "--with", "agent", "--description", "Fixture tools for the adoption test.");
  const dropped = ["team-brainstorm", "format-json"].filter((name) => present.includes(name));
  if (dropped.length) await removeExamples(directory, ...dropped);

  const catalog = await json(join(directory, "marketplace.json"));
  catalog.name = `${fixture}-marketplace`;
  catalog.owner = { name: "Acme" };
  catalog.plugins = catalog.plugins.filter((entry) => typeof entry.source === "string");
  await writeJson(join(directory, "marketplace.json"), catalog);
  const manifest = await json(join(directory, "package.json"));
  await writeJson(join(directory, "package.json"), { ...manifest, name: `${fixture}-marketplace` });
  await writeJson(join(directory, ".github/copilot/settings.json"), {
    extraKnownMarketplaces: { [catalog.name]: { source: { source: "directory", path: "." } } },
    enabledPlugins: Object.fromEntries(catalog.plugins.map((entry) => [`${entry.name}@${catalog.name}`, true])),
  });

  const { validated, coverage } = await verify(directory);
  assert.match(validated, /0 remote references/);
  assert.doesNotMatch(validated, /name is still the template's/);
  assert.match(coverage, new RegExp(`skill:${fixture}-tools/${fixture}-tools`));
  assert.match(coverage, new RegExp(`agent:${fixture}-tools/${fixture}-tools-specialist`));
  assert.match(coverage, new RegExp(`mcp:${fixture}-tools/${fixture}-tools/echo`));
  for (const name of dropped) assert.doesNotMatch(coverage, new RegExp(`:${name}/`));
  const params = JSON.stringify(parse(await readFile(join(directory, ".vally.yaml"), "utf8")).params ?? {});
  for (const name of dropped) assert.doesNotMatch(params, new RegExp(name));

  // Scaffolding refuses names that would collide or aren't valid plugin names.
  for (const name of [`${fixture}-tools`, "Bad_Name"]) {
    const refused = await run(directory, "scripts/new-plugin.mjs", name);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /already|must be lowercase/);
    assert.doesNotMatch(refused.stderr, /\n\s+at /, "Expected a plain message, not a stack trace.");
  }

  // Every problem is reported at once as `path: message`, without a stack trace.
  const vally = parse(await readFile(join(directory, ".vally.yaml"), "utf8"));
  vally.paths.skills = vally.paths.skills.filter((path) => !path.includes(fixture));
  await writeFile(join(directory, ".vally.yaml"), stringify(vally));
  await writeFile(join(directory, "README.md"), `${await readFile(join(directory, "README.md"), "utf8")}\n[one](missing-one.md) [two](missing-two.md)\n`);
  const stale = await run(directory, "scripts/validate.mjs");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, new RegExp(`\\.vally\\.yaml paths\\.skills must list plugins/${fixture}-tools/skills`));
  assert.match(stale.stderr, /README\.md: broken relative link missing-one\.md/);
  assert.match(stale.stderr, /README\.md: broken relative link missing-two\.md/);
  assert.doesNotMatch(stale.stderr, /\n\s+at /);
});

// The order a solo developer or a remote-only curator might take: strip every
// example and remote entry first, then scaffold into what's left. In the
// template that's an empty catalog; in your marketplace, your own plugins stay.
test("an empty or remote-only marketplace passes verify, and new plugins scaffold into it", { timeout: 900_000 }, async (t) => {
  const directory = await scratchRepository(t);
  const prefix = `adoption-${randomBytes(3).toString("hex")}`;
  if (present.length) await ok(directory, "scripts/remove-plugin.mjs", "--example", "--all");
  for (const example of present) {
    for (const path of [`plugins/${example}`, `evals/${example}`, ...examples[example].paths]) {
      assert.ok(!existsSync(join(directory, path)), `${path} should be removed with ${example}.`);
    }
  }
  const vally = parse(await readFile(join(directory, ".vally.yaml"), "utf8"));
  for (const example of present) for (const param of examples[example].params) assert.equal(vally.params?.[param], undefined);
  const before = await json(join(directory, "marketplace.json"));
  const ownPlugins = before.plugins.filter((entry) => typeof entry.source === "string");
  const readme = await readFile(join(directory, "README.md"), "utf8");
  if (present.length) {
    assert.ok(!existsSync(join(directory, "docs/examples.md")), "The examples guide goes with the last example.");
    assert.doesNotMatch(readme, /Six small example plugins|authoring reference/);
    if (!ownPlugins.length && readme.includes("<!-- plugin-table -->")) {
      assert.match(readme, /<!-- plugin-table -->\n\| Plugin \| Try it \| Teaches \|\n\|---\|---\|---\|\n\| _None yet\._ \| \| \|\n/);
    }
  }

  // Only remote entries (and your own plugins) left: everything still passes, including the tests.
  const remote = await verify(directory);
  if (!ownPlugins.length) assert.match(remote.validated, /There are no local plugins yet/);

  for (const entry of before.plugins.filter((item) => typeof item.source !== "string")) {
    await ok(directory, "scripts/remove-plugin.mjs", entry.name);
  }
  assert.ok((await json(join(directory, "marketplace.json"))).plugins.every((entry) => typeof entry.source === "string"));
  const empty = await verify(directory, { tests: false });
  if (!ownPlugins.length) assert.match(empty.coverage, /nothing to cover/);
  // The setup steps about examples go with them, and the list stays numbered in order.
  const setup = (await readFile(join(directory, "README.md"), "utf8")).match(/## Make it yours\n[\s\S]*?\n## /)?.[0];
  if (setup) {
    if (present.length) assert.doesNotMatch(setup, /remove-example/);
    const numbers = [...setup.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
  }

  const [hook, canvas, skill] = ["lint", "standup", "notes"].map((name) => `${prefix}-${name}`);
  await newPlugin(directory, hook, "--no-skill", "--with", "hook");
  await newPlugin(directory, canvas, "--with", "extension");
  await newPlugin(directory, skill);
  const scaffolded = await verify(directory);
  for (const id of [`hook:${hook}/postToolUse`, `extension:${canvas}/${canvas}`, `skill:${canvas}/${canvas}`, `skill:${skill}/${skill}`]) {
    assert.match(scaffolded.coverage, new RegExp(id));
  }
  const listed = await readFile(join(directory, "README.md"), "utf8");
  if (listed.includes("<!-- plugin-table -->")) {
    assert.doesNotMatch(listed, /_None yet\._/);
    for (const name of [hook, canvas, skill]) assert.match(listed, new RegExp(`\\| \\[${name}\\]\\(plugins/${name}/\\) \\|`));
  }
  assert.match(scaffolded.validated, /still has scaffolded text/);

  // Removing a scaffolded plugin takes the support files named after it.
  await ok(directory, "scripts/remove-plugin.mjs", canvas, hook);
  for (const path of [`evals/graders/${canvas}.mjs`, `test/${hook}-hook.test.mjs`]) assert.ok(!existsSync(join(directory, path)), path);
  assert.ok(!Object.values(parse(await readFile(join(directory, ".vally.yaml"), "utf8")).params ?? {}).some((value) => String(value).includes(canvas)));
  await verify(directory, { tests: false });
});

test("rename-marketplace renames the catalog, overlay, package, and install commands together", { timeout: 600_000 }, async (t) => {
  const directory = await scratchRepository(t);
  const before = await json(join(directory, "marketplace.json"));
  const templateTitle = (await readFile(join(directory, "README.md"), "utf8")).startsWith("# Plugin marketplace starter\n");
  await ok(directory, "scripts/rename-marketplace.mjs", "--name", "jdoe-skills", "--owner", "jdoe", "--repo", "jdoe/my-skills");
  const catalog = await json(join(directory, "marketplace.json"));
  assert.equal(catalog.name, "jdoe-skills");
  assert.equal(catalog.owner.name, "jdoe");
  assert.equal(catalog.plugins.length, before.plugins.length);
  const settings = await json(join(directory, ".github/copilot/settings.json"));
  assert.deepEqual(Object.keys(settings.extraKnownMarketplaces), ["jdoe-skills"]);
  assert.ok(Object.keys(settings.enabledPlugins).every((key) => key.endsWith("@jdoe-skills")));
  const manifest = await json(join(directory, "package.json"));
  assert.equal(manifest.name, "jdoe-skills");
  assert.equal(manifest.repository.url, "https://github.com/jdoe/my-skills");
  const lock = await json(join(directory, "package-lock.json"));
  assert.equal(lock.name, "jdoe-skills");
  assert.equal(lock.packages[""].name, "jdoe-skills");
  const readme = await readFile(join(directory, "README.md"), "utf8");
  if (templateTitle) assert.match(readme, /^# Jdoe Skills\n/);
  assert.doesNotMatch(readme, /plugin-marketplace-starter|currently private/);
  if (catalog.plugins.some((entry) => typeof entry.source === "string")) assert.match(readme, /copilot plugin marketplace add jdoe\/my-skills/);
  for (const name of present) {
    const pluginReadme = await readFile(join(directory, "plugins", name, "README.md"), "utf8");
    assert.match(pluginReadme, new RegExp(`copilot plugin install ${name}@jdoe-skills`));
    assert.doesNotMatch(pluginReadme, /OWNER\/REPO|MARKETPLACE/);
  }
  const { validated } = await verify(directory, { tests: false });
  assert.doesNotMatch(validated, /name is still the template's|still names the template's marketplace|OWNER\/REPO/);
  if (readme.includes("A GitHub template for building, evaluating, and sharing AI customizations")) {
    // rename-marketplace changes the title, but the introduction is still the template's.
    assert.match(validated, /README\.md: the title or introduction is still the template's/);
  }
  const holders = [...(await readFile(join(directory, "LICENSE"), "utf8")).matchAll(/^Copyright \(c\) \d{4} (.+?)\s*$/gm)].map((match) => match[1]);
  if (holders.length && holders.every((holder) => holder === "GitHub, Inc.")) {
    // rename-marketplace leaves LICENSE alone, so the template's holder is still the only one.
    assert.match(validated, /LICENSE: names only GitHub, Inc\., the template's holder/);
  }

  // A new plugin's README uses the real repository, and a second rename works too.
  await newPlugin(directory, "regex-explainer");
  assert.match(await readFile(join(directory, "plugins/regex-explainer/README.md"), "utf8"), /copilot plugin marketplace add jdoe\/my-skills\ncopilot plugin install regex-explainer@jdoe-skills/);
  await ok(directory, "scripts/rename-marketplace.mjs", "--name", "jdoe-tools", "--owner", "jdoe", "--repo", "jdoe/tools");
  assert.match(await readFile(join(directory, "plugins/regex-explainer/README.md"), "utf8"), /marketplace add jdoe\/tools\ncopilot plugin install regex-explainer@jdoe-tools/);
  await ok(directory, "scripts/validate.mjs");
  for (const args of [["--name", "Bad Name", "--owner", "x", "--repo", "a/b"], ["--name", "ok", "--owner", "x", "--repo", "https://github.com/a/b"]]) {
    const refused = await run(directory, "scripts/rename-marketplace.mjs", ...args);
    assert.notEqual(refused.status, 0);
    assert.doesNotMatch(refused.stderr, /\n\s+at /);
  }
});

test("each example can be removed on its own", { timeout: 600_000, skip: !present.length && "no examples left" }, async (t) => {
  const pending = [...present];
  const worker = async () => {
    for (let name = pending.shift(); name; name = pending.shift()) {
      const directory = await scratchRepository(t);
      await removeExamples(directory, name);
      await verify(directory, { tests: false });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
});

test("removal renumbers a list that lost a marked step", () => {
  const text = ["1. One", "   <!-- plugin:gone -->", "2. Gone", "   more about it", "   <!-- /plugin:gone -->", "3. Three", "   detail", "", "4. Four", "", "Other text.", "1. Separate", "3. List"].join("\n");
  assert.equal(pruneMarkdown(text, ["gone"], () => false), ["1. One", "2. Three", "   detail", "", "3. Four", "", "Other text.", "1. Separate", "2. List"].join("\n"));
  assert.equal(pruneMarkdown("1. One\n3. Kept as is\n", [], () => false), "1. One\n3. Kept as is\n");
});

test("removal prunes install commands, marked sections, example table rows, and links to removed files", () => {
  assert.equal(pruneMarkdown(["| Plugin | Notes |", "|---|---|", "| [gone](plugins/gone/) | row |", "", "<!-- examples -->", "Six examples.", "<!-- /examples -->", "after"].join("\n"),
    ["gone"], (link) => link.startsWith("plugins/gone"), ["examples"]), ["| Plugin | Notes |", "|---|---|", "| _None yet._ | |", "", "after"].join("\n"));
  const removed = (link) => link.startsWith("plugins/gone") || link.startsWith("../plugins/gone");
  const text = [
    "| [gone](plugins/gone/) | row |",
    "| [kept](plugins/kept/) | row |",
    "| Hook | [gone](plugins/gone/) |",
    "copilot plugin install gone@market",
    "copilot plugin install kept@market",
    "<!-- plugin:gone -->",
    "Only about gone.",
    "<!-- /plugin:gone -->",
    "See [the gone README](../plugins/gone/README.md) and [kept](plugins/kept/).",
  ].join("\n");
  assert.equal(pruneMarkdown(text, ["gone"], removed), [
    "| [kept](plugins/kept/) | row |",
    "| Hook | gone |",
    "copilot plugin install kept@market",
    "See the gone README and [kept](plugins/kept/).",
  ].join("\n"));
});
