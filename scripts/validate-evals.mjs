import { isEntrypoint } from "./entrypoint.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { contained, effectiveTags, evalFilenameMatcher, evalFilenames, expectedCases, frontmatter, parseYaml, readCatalog, readVallyConfig } from "./catalog.mjs";
import { Problems, relativePath, runCli } from "./problems.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const matches = (pattern, value) => typeof pattern === "string" && new RegExp(pattern).test(value);
// Graders that check what happened, not only that something was invoked. One of
// these makes a positive case count as outcome coverage.
export const outcomeGraders = Object.freeze(["program", "output-matches", "output-contains", "file-matches", "file-exists", "prompt", "panel"]);
async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

// Starts a plugin's real stdio MCP server to discover the tools it advertises.
export async function listMcpTools(pluginRoot, server) {
  assert.equal(server.type, "stdio", "Only local stdio MCP servers can be discovered.");
  const data = await mkdtemp(join(tmpdir(), "starter-mcp-data-"));
  const expand = (value) => value.replaceAll("${PLUGIN_ROOT}", pluginRoot).replaceAll("${PLUGIN_DATA}", data);
  const configuredCwd = server.cwd ?? "${PLUGIN_ROOT}";
  const cwd = configuredCwd.startsWith("${PLUGIN_DATA}") ? await contained(data, expand(configuredCwd)) : await contained(pluginRoot, expand(configuredCwd));
  const command = server.command.startsWith("./") ? await contained(pluginRoot, server.command) : server.command;
  const transport = new StdioClientTransport({
    command,
    args: (server.args ?? []).map(expand),
    cwd,
    env: {
      ...getDefaultEnvironment(),
      ...Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value)])),
      PLUGIN_ROOT: pluginRoot,
      PLUGIN_DATA: data,
    },
    stderr: "inherit",
  });
  const client = new Client({ name: "starter-inventory", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: 30_000 });
    const tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 30_000 });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    assert.ok(tools.length, `MCP server in ${pluginRoot} advertises no tools.`);
    return tools;
  } finally {
    try { await client.close(); }
    finally {
      try { await transport.close(); }
      finally { await rm(data, { recursive: true, force: true }); }
    }
  }
}

export async function discoverAssets(directory = root) {
  const { localPlugins } = await readCatalog(directory);
  const assets = [];
  for (const plugin of localPlugins) {
    const source = resolve(directory, plugin.source);
    assert.ok(!relative(resolve(directory, "plugins"), source).split(sep).includes(".."));
    for (const skill of (await entries(resolve(source, "skills"))).filter((entry) => entry.isDirectory())) {
      const path = resolve(source, "skills", skill.name);
      await stat(resolve(path, "SKILL.md"));
      assets.push({ id: `skill:${plugin.name}/${skill.name}`, kind: "skill", name: skill.name, path });
    }
    const agentsPath = resolve(source, "com.github.copilot/agents");
    for (const agent of (await entries(agentsPath)).filter((entry) => entry.isFile() && entry.name.endsWith(".agent.md"))) {
      const path = resolve(agentsPath, agent.name);
      const { name } = frontmatter(await readFile(path, "utf8"), path);
      assets.push({ id: `agent:${plugin.name}/${name}`, kind: "agent", name, path });
    }
    let hooks;
    try { hooks = await json(resolve(source, "com.github.copilot/hooks/hooks.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const event of Object.keys(hooks?.hooks ?? {})) {
      assets.push({ id: `hook:${plugin.name}/${event}`, kind: "hook", name: event, plugin: plugin.name, path: source });
    }
    for (const extension of (await entries(resolve(source, "com.github.copilot/extensions"))).filter((entry) => entry.isDirectory())) {
      const path = resolve(source, "com.github.copilot/extensions", extension.name);
      await stat(resolve(path, "extension.mjs"));
      assets.push({ id: `extension:${plugin.name}/${extension.name}`, kind: "extension", name: extension.name, path });
    }
    let mcp;
    try { mcp = await json(resolve(source, "mcp.json")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [serverName, server] of Object.entries(mcp?.mcpServers ?? {})) {
      for (const tool of await listMcpTools(source, server)) {
        assets.push({ id: `mcp:${plugin.name}/${serverName}/${tool.name}`, kind: "mcp", name: tool.name, serverName, path: source });
      }
    }
  }
  assert.equal(new Set(assets.map((asset) => asset.id)).size, assets.length, "Duplicate asset identity.");
  return assets;
}

// Mirrors Vally's discovery: configured evalFilenames, skipping dist,
// node_modules, and hidden directories. Returns an empty list when there are no
// specs; the coverage check then reports any asset that still needs one.
export async function readEvals(directory = root, config) {
  const vally = config ?? await readVallyConfig(directory);
  const patterns = evalFilenames(vally);
  const isEval = evalFilenameMatcher(patterns);
  const specs = [];
  async function walk(path) {
    for (const entry of await entries(path)) {
      const child = resolve(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Do not use symlinked eval inputs: ${child}`);
      if (entry.isDirectory()) {
        if (!["dist", "node_modules"].includes(entry.name) && !entry.name.startsWith(".")) await walk(child);
      } else if (isEval(entry.name)) specs.push({ path: child, spec: parseYaml(await readFile(child, "utf8"), child) });
    }
  }
  await walk(resolve(directory, "evals"));
  return specs;
}

// Tag values that select a stimulus into a configured tag-filtered suite.
export function suiteTags(config) {
  return new Set(Object.values(config?.suites ?? {}).flatMap((suite) => list(suite?.filter?.suite)));
}

const programArgs = (graders, script) => graders.some((grader) => grader.type === "program" && list(grader.config?.args).includes(script));

// Evidence that a hook actually ran, not just that the model did the task. A
// program grader can check real effects. A built-in grader counts only when it
// matches the hook's own diagnostic prefix, "<plugin>:", which only the hook
// writes, for example into the edit tool's result.
export function hookEvidence(grader, plugin) {
  const marker = `${plugin}:`;
  const has = (value) => typeof value === "string" && value.includes(marker);
  if (grader.type === "program") return true;
  if (grader.type === "tool-calls") return list(grader.config?.required).some((rule) => typeof rule === "object" && has(rule?.result));
  if (["output-matches", "file-matches"].includes(grader.type)) return has(grader.config?.pattern);
  if (grader.type === "output-contains") return has(grader.config?.substring);
  return false;
}

// Extra checks for the shipped examples. They apply only while those exact
// assets exist, so renaming or deleting an example removes its contract too.
const exampleContracts = {
  "hook:format-json/postToolUse": ({ graders }) => {
    assert.ok(programArgs(graders, ".grading/format-json.mjs"), "hook:format-json/postToolUse: grade the hook's actual file effects.");
  },
  "extension:team-brainstorm/brainstorm": ({ stimulus, mcpServers, graders }) => {
    const id = "extension:team-brainstorm/brainstorm";
    assert.equal(stimulus.tags.boundary, "headless-sdk-contract", `${id}: label the host boundary honestly.`);
    assert.ok(mcpServers["brainstorm-host"], `${id}: configure the actual extension contract transport.`);
    assert.ok(programArgs(graders, ".grading/brainstorm.mjs"), `${id}: grade the extension's actual session state.`);
  },
};

function checkPositive(asset, stimulus, spec, path, directory) {
  const id = asset.id;
  const graders = stimulus.graders ?? [];
  const env = { ...spec.agent_environment?.env, ...stimulus.agent_environment?.env };
  const mcpServers = { ...spec.agent_environment?.mcpServers, ...stimulus.agent_environment?.mcpServers };
  assert.ok(graders.some((grader) => outcomeGraders.includes(grader.type)
    || grader.type === "tool-calls" && (asset.kind === "mcp" || asset.kind === "hook" && hookEvidence(grader, asset.plugin))),
    `${id}: invocation alone isn't outcome coverage. Add an outcome grader: ${outcomeGraders.join(", ")}${asset.kind === "mcp" ? ", or a tool-calls rule with the tool's result" : asset.kind === "hook" ? ", or a tool-calls rule whose result matches the hook's diagnostic" : ""}.`);
  if (asset.kind === "skill") {
    const skills = [...list(spec.agent_environment?.skills), ...list(stimulus.agent_environment?.skills)];
    assert.ok(skills.some((skill) => resolve(dirname(path), skill) === asset.path), `${id}: load the actual skill. List its directory in agent_environment.skills, relative to the eval file, for example ../../${relativePath(directory, asset.path)}.`);
    assert.ok(graders.some((grader) => grader.type === "skill-invocation" && list(grader.config?.required).includes(asset.name)),
      `${id}: assert actual skill invocation with a skill-invocation grader whose config.required lists ${asset.name}.`);
  } else if (asset.kind === "agent") {
    const files = [...list(spec.agent_environment?.files), ...list(stimulus.agent_environment?.files)];
    assert.ok(files.some((file) => typeof file.src === "string"
      && resolve(dirname(path), file.src) === asset.path
      && file.dest === `.github/agents/${asset.name}.agent.md`),
    `${id}: stage the actual agent profile with agent_environment.files, as dest: .github/agents/${asset.name}.agent.md, so the agent's name matches its file.`);
    assert.ok(graders.some((grader) => grader.type === "tool-calls"
      && list(grader.config?.required).some((rule) => typeof rule === "object"
        && rule.name === "^task$" && rule.args?.agent_type === `^${escapeRegExp(asset.name)}$`)),
    `${id}: assert delegation to the actual agent.`);
    assert.ok(graders.some((grader) => grader.scope === "subagent"
      && ["program", "output-matches", "output-contains", "prompt"].includes(grader.type)),
    `${id}: grade the subagent's behavior, not only the parent answer.`);
  } else if (asset.kind === "mcp") {
    assert.ok(mcpServers[asset.serverName], `${id}: configure the actual MCP server.`);
    assert.ok(graders.some((grader) => grader.type === "tool-calls"
      && list(grader.config?.required).some((rule) => typeof rule === "object"
        && matches(rule.name, asset.name) && typeof rule.result === "string" && rule.result.length > 0)),
    `${id}: assert the actual tool call and its result.`);
  } else if (asset.kind === "hook") {
    const mounted = String(env.STARTER_PLUGIN_DIRS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      .map((value) => resolve(directory, value));
    assert.ok(mounted.includes(asset.path), `${id}: mount the real plugin with agent_environment.env.STARTER_PLUGIN_DIRS.`);
    assert.ok(graders.some((grader) => hookEvidence(grader, asset.plugin)),
      `${id}: prove the hook ran. Use a program grader that checks its real effects, or a built-in grader that matches the hook's own "${asset.plugin}:" diagnostic: `
      + `a tool-calls rule whose result pattern includes it, or output-matches, output-contains, or file-matches with it. `
      + "A file grader on content the model wrote passes even when the hook never ran. See docs/evals.md#hooks.");
  } else {
    assert.ok(typeof stimulus.tags.boundary === "string" && stimulus.tags.boundary.trim(),
      `${id}: label the host boundary honestly with tags.boundary.`);
    assert.ok(Object.keys(mcpServers).length, `${id}: configure the transport that exercises the actual extension.`);
    assert.ok(graders.some((grader) => grader.type === "program"), `${id}: grade the extension's actual state with a program grader.`);
  }
  exampleContracts[id]?.({ stimulus, mcpServers, graders });
}

// A negative control must assert something observable. For an MCP tool that's
// either an asserted error or result from a real call, or the tool being disallowed.
// A skill-invocation grader that disallows the skill also counts for a skill,
// since that is the non-trigger assertion the authoring skill teaches.
function checkNegative(asset, graders) {
  if (asset.kind === "skill" && graders.some((grader) => grader.type === "skill-invocation" && list(grader.config?.disallowed).includes(asset.name))) return true;
  if (asset.kind !== "mcp") return graders.some((grader) => outcomeGraders.includes(grader.type) || grader.type === "tool-calls");
  return graders.some((grader) => grader.type === "tool-calls" && (
    list(grader.config?.required).some((rule) => typeof rule === "object"
      && matches(rule.name, asset.name) && typeof rule.result === "string" && rule.result.length > 0)
    || list(grader.config?.disallowed).some((rule) => matches(typeof rule === "object" ? rule?.name : rule, asset.name))));
}

const negativeHint = (asset) => asset.kind === "mcp"
  ? `a tool-calls rule that requires a real ${asset.name} call with an asserted result or error, or one that disallows ${asset.name}`
  : `one of ${asset.kind === "skill" ? `a skill-invocation grader with config.disallowed: [${asset.name}], ` : ""}tool-calls, ${outcomeGraders.join(", ")}`;

export function checkCoverage(assets, specs, { directory = root, suites = new Set(["smoke"]), smokeSuite = "smoke" } = {}) {
  const problems = new Problems(directory);
  if (!suites.has(smokeSuite)) {
    problems.add(".vally.yaml", `needs a "${smokeSuite}" suite that filters on tags.suite.`);
    problems.throwIfAny();
  }
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const covered = new Set();
  const smoke = new Set();
  const negative = new Set();
  const weakNegatives = new Map();
  const names = new Set();
  for (const { path, spec } of specs) {
    const file = relativePath(directory, path);
    if (!Array.isArray(spec?.stimuli) || !spec.stimuli.length) {
      problems.add(file, "stimuli are required.");
      continue;
    }
    for (const stimulus of spec.stimuli) {
      const where = `${file} (${stimulus?.name ?? "unnamed stimulus"})`;
      if (!stimulus?.name) problems.add(where, "every stimulus needs a name.");
      else if (names.has(stimulus.name)) problems.add(where, "stimulus names must be unique across all eval files so saved results map to one case. Prefix it with the skill or plugin name.");
      names.add(stimulus?.name);
      // Vally merges the eval's top-level tags into each case, so coverage does too.
      const tags = effectiveTags(spec, stimulus);
      const ids = list(tags.assets);
      if (!ids.length) {
        problems.add(where, 'declare the assets this case covers in tags.assets, for example tags: { assets: ["skill:<plugin>/<skill>"], control: positive, suite: smoke }.');
        continue;
      }
      if (!["positive", "negative"].includes(tags.control)) {
        problems.add(where, "set tags.control to positive or negative.");
        continue;
      }
      for (const suite of list(tags.suite)) {
        if (!suites.has(suite)) problems.add(where, `tags.suite "${suite}" isn't a configured suite filter in .vally.yaml (${[...suites].join(", ")}).`);
      }
      for (const id of ids) {
        const asset = byId.get(id);
        if (!asset) {
          problems.add(where, `unknown asset ${id}. Known assets: ${[...byId.keys()].join(", ") || "none"}.`);
          continue;
        }
        if (tags.control === "negative") {
          if (checkNegative(asset, stimulus.graders ?? [])) negative.add(id);
          else weakNegatives.set(id, [...(weakNegatives.get(id) ?? []), where]);
          continue;
        }
        const before = problems.list.length;
        problems.checkSync(where, () => checkPositive(asset, { ...stimulus, tags }, spec, path, directory));
        if (problems.list.length !== before) continue;
        covered.add(id);
        if (list(tags.suite).includes(smokeSuite)) smoke.add(id);
      }
    }
  }
  for (const [id, asset] of byId) {
    if (!covered.has(id)) problems.add(id, `missing positive behavioral coverage. Add a case with tags.assets: ${id} and tags.control: positive that loads the actual asset and asserts both its invocation and its outcome.`);
    else if (!smoke.has(id)) problems.add(id, `missing ${smokeSuite} coverage. Add tags.suite: ${smokeSuite} to one of its positive cases.`);
    if (!negative.has(id)) {
      const weak = weakNegatives.get(id);
      problems.add(id, `missing negative control with an observable assertion. Add a case with tags.assets: ${id} and tags.control: negative that uses ${negativeHint(asset)}.`
        + (weak ? ` These negative cases don't assert anything observable for it: ${weak.join("; ")}.` : ""));
    }
  }
  problems.throwIfAny();
  return names.size;
}

if (isEntrypoint(import.meta.url)) {
  await runCli(async () => {
    const config = await readVallyConfig(root);
    const assets = await discoverAssets();
    const specs = await readEvals(root, config);
    if (assets.length && !specs.length) {
      throw new Error(`No eval files matching ${evalFilenames(config).join(", ")} (.vally.yaml evalFilenames) were found under evals/, but ${assets.length} local assets need coverage. Add evals, or check evalFilenames.`);
    }
    const count = checkCoverage(assets, specs, { suites: suiteTags(config) });
    if (!assets.length && !specs.length) {
      console.log("No local plugins or eval specs yet, so there's nothing to cover. Add a plugin with npm run new-plugin -- <name>; it writes an eval that meets these rules.");
      return;
    }
    const kinds = Object.entries(Object.groupBy(assets, (asset) => asset.kind)).map(([kind, items]) => `${items.length} ${kind}`).join(", ");
    console.log(`Validated ${specs.length} eval specs and ${count} cases covering ${assets.length} local assets (${kinds}).`);
    for (const asset of assets) console.log(`  ${asset.id}`);
    // Each case is at least one real Copilot session, so this is the size of a paid run.
    const size = (suite) => { try { return expectedCases(specs, config, { suite }).size; } catch { return 0; } };
    const sizes = Object.keys(config?.suites ?? {}).map((suite) => `${suite}: ${size(suite)} cases`);
    if (sizes.length) console.log(`Suite sizes (each case runs at least one Copilot session): ${sizes.join(", ")}.`);
    if (assets.some((asset) => asset.kind === "extension")) {
      console.log("Extensions are evaluated through a headless MCP/SDK contract, not native UI rendering.");
    }
  });
}
