import { isEntrypoint } from "./entrypoint.mjs";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Ajv from "ajv/dist/2020.js";
import { contained, frontmatter, readCatalog, readVallyConfig, remoteWarnings } from "./catalog.mjs";
import { Problems, runCli } from "./problems.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const ignored = [".git", "node_modules", "vally-results", ".vally", ".copilot-home"];
const ajv = new Ajv({ allErrors: true });
const validatePluginManifest = ajv.compile(await json(resolve(root, "schemas/plugin.schema.json")));
const validateMcp = ajv.compile(await json(resolve(root, "schemas/mcp.schema.json")));

// Plugin directories under plugins/. A marketplace with no local plugins may not
// have that directory at all, because git doesn't keep empty directories.
export async function pluginDirectories(directory) {
  try {
    return (await readdir(resolve(directory, "plugins"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function files(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (await Promise.all(entries.filter((entry) => !ignored.includes(entry.name))
    .map((entry) => entry.isDirectory() ? files(resolve(path, entry.name)) : resolve(path, entry.name)))).flat();
}

// Event names from the Copilot hooks reference:
// https://docs.github.com/en/copilot/reference/hooks-reference#hook-events
export const hookEvents = Object.freeze([
  "agentStop", "errorOccurred", "notification", "permissionRequest", "postToolUse", "postToolUseFailure", "preCompact",
  "preToolUse", "sessionEnd", "sessionStart", "subagentStart", "subagentStop", "userPromptSubmitted", "userPromptTransformed",
]);

// Relative link targets in Markdown, ignoring fenced code blocks, inline code,
// web URLs, mailto links, and same-page anchors.
export function markdownLinks(text) {
  const prose = text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "")
    .replace(/(`+)[^\n]*?\1/g, "");
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])
    .filter((link) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link));
}

// Shape from the Copilot CLI plugin reference's LSP server configuration.
export function validateLspConfig(config, label) {
  const servers = Object.entries(config?.lspServers ?? {});
  assert.ok(config && typeof config.lspServers === "object" && !Array.isArray(config.lspServers) && servers.length,
    `${label}: lsp.json needs an lspServers object with at least one server.`);
  for (const [name, server] of servers) {
    assert.ok(["command", "bash", "powershell"].some((key) => typeof server?.[key] === "string" && server[key].trim()),
      `${label}/${name}: set command, bash, or powershell.`);
    assert.ok(server.fileExtensions && typeof server.fileExtensions === "object" && Object.keys(server.fileExtensions).length,
      `${label}/${name}: map at least one file extension to a language ID.`);
  }
  return servers.length;
}

export async function validateMcpConfig(directory, label) {
  const config = await json(resolve(directory, "mcp.json"));
  assert.ok(validateMcp(config), `${label}: ${ajv.errorsText(validateMcp.errors)}`);
  const servers = Object.entries(config.mcpServers);
  assert.ok(servers.length, `${label}: mcp.json declares no servers.`);
  for (const [name, server] of servers) {
    assert.equal(server.type, "stdio", `${label}/${name}: in-repo plugins ship self-contained local stdio servers.`);
    if (server.command.startsWith("./")) await contained(directory, server.command);
    else assert.match(server.command, /^[\w.-]+$/, `${label}/${name}: use a bare executable or a contained ./ path.`);
    for (const value of [...(server.args ?? []), server.cwd ?? "${PLUGIN_ROOT}"]) {
      assert.ok(!value.includes("${PLUGIN_DATA}") || value.startsWith("${PLUGIN_DATA}"), `${label}/${name}: invalid PLUGIN_DATA use.`);
      if (value.startsWith("${PLUGIN_ROOT}")) await contained(directory, `.${value.slice("${PLUGIN_ROOT}".length) || "/"}`);
    }
  }
  return servers.length;
}

// Vally lints skills from .vally.yaml paths.skills, so a renamed or added plugin
// must be listed there too. Failing here names the file to fix.
export async function validateVallySkillPaths(directory, localPlugins) {
  const config = await readVallyConfig(directory);
  assert.ok(config, ".vally.yaml is required; it lists skill directories, eval filenames, params, and suites.");
  const listed = config.paths?.skills === undefined ? [] : [config.paths.skills].flat();
  assert.ok(listed.every((path) => typeof path === "string" && path), ".vally.yaml paths.skills must be a list of directories.");
  const problems = new Problems(directory);
  const resolved = new Set(listed.map((path) => resolve(directory, path)));
  for (const path of listed) {
    try { assert.ok((await stat(resolve(directory, path))).isDirectory()); }
    catch { problems.add("", `.vally.yaml paths.skills lists ${path}, which doesn't exist. Update it after renaming or removing a plugin.`); }
  }
  for (const entry of localPlugins) {
    const skills = resolve(directory, entry.source, "skills");
    let exists = false;
    try { exists = (await stat(skills)).isDirectory(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (exists && !resolved.has(skills)) problems.add("", `.vally.yaml paths.skills must list ${relative(directory, skills).split(sep).join("/")} so Vally lints ${entry.name}'s skills.`);
  }
  problems.throwIfAny();
}

export const templateDefaults = Object.freeze({ marketplace: "plugin-marketplace-starter", owner: "GitHub", package: "plugin-marketplace-starter" });
// The start of the template README's introduction. rename-marketplace changes
// the title but leaves the introduction for you to rewrite.
export const templateIntroduction = "A GitHub template for building, evaluating, and sharing AI customizations";

// Mentions of plugins/<name> in Markdown, CODEOWNERS, and workflow files,
// including inside code spans, so a removed or renamed plugin can't linger in
// prose. Fenced code blocks are skipped; they often hold illustrative examples.
export function pluginMentions(text) {
  const mentions = [];
  let fence;
  text.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) { fence = fence ? undefined : marker[0].repeat(3); return; }
    if (fence) return;
    for (const match of line.matchAll(/(?<![\w-])(?<!\w\/)plugins\/([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g)) {
      mentions.push({ line: index + 1, name: match[1] });
    }
  });
  return mentions;
}

// Warnings, not failures: leftovers from the template that a team usually wants to change.
export async function staleReferenceWarnings(directory, catalog, allFiles) {
  const warnings = [];
  if (catalog?.name === templateDefaults.marketplace) {
    warnings.push(`marketplace.json: name is still the template's "${templateDefaults.marketplace}". Run npm run rename-marketplace to rename it everywhere at once.`);
  }
  if (catalog?.owner?.name === templateDefaults.owner) {
    warnings.push(`marketplace.json: owner.name is still the template's "${templateDefaults.owner}". Set it to your team or organization, for example with npm run rename-marketplace.`);
  }
  try {
    if ((await json(resolve(directory, "package.json"))).name === templateDefaults.package) {
      warnings.push(`package.json: name is still the template's "${templateDefaults.package}". Run npm run rename-marketplace, or rename it to match your repository.`);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const existing = new Set(await pluginDirectories(directory));
  for (const file of allFiles) {
    const path = relative(directory, file).split(sep).join("/");
    if (!(path.endsWith(".md") || path === ".github/CODEOWNERS" || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path))) continue;
    for (const { line, name } of pluginMentions(await readFile(file, "utf8"))) {
      if (!existing.has(name)) warnings.push(`${path}:${line}: mentions plugins/${name}, which doesn't exist. Update or remove the reference.`);
    }
  }
  warnings.push(...await adoptionWarnings(directory, catalog, allFiles));
  return warnings;
}

// Phrases npm run new-plugin writes into each file it scaffolds. Each one stays
// until someone replaces the scaffold with the real thing.
export const scaffoldText = Object.freeze([
  "Replace this description with the real trigger",
  "Replace these instructions with your team's procedure",
  "Replace this description with when the main agent should delegate to it",
  "Replace these instructions with the specialist's role",
  "Replace the scaffolded instructions",
  "Replace this example tool with your own",
  "Replace this with the hook's real work",
  "Replace the actions and the page with your own",
  "Scaffolded checks for the",
]);
// The holder named in the template's root LICENSE, which covers the whole
// repository, plugins included. Its MIT notice stays in anything you keep; see
// Licensing in README.md.
export const templateLicenseHolder = "GitHub, Inc.";
const read = async (path) => { try { return await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; } };

// Every holder named on a "Copyright" line in a license file.
export function copyrightHolders(text = "") {
  return [...text.matchAll(/^\s*Copyright(?:\s+\(c\)|\s+©)?\s+(?:\d{4}(?:\s*[-,]\s*\d{4})*,?\s+)?(.+?)\s*$/gim)].map((match) => match[1]);
}

// Leftovers that matter once a team has made the marketplace its own: scaffold
// text always, and the template's name, introduction, license lines, and
// placeholder contacts after the marketplace has been renamed.
async function adoptionWarnings(directory, catalog, allFiles) {
  const warnings = [];
  for (const file of allFiles) {
    const path = relative(directory, file).split(sep).join("/");
    if (!/^(?:plugins\/[^/]+\/(?!dist\/).+\.(?:md|ts|mjs|js)|evals\/[^/]+\/.+\.ya?ml)$/.test(path)) continue;
    // Comment markers and line breaks don't split a phrase.
    const text = (await readFile(file, "utf8")).replace(/\s*(?:\/\/|#)?\s+/g, " ");
    const phrase = scaffoldText.find((item) => text.includes(item));
    if (phrase) warnings.push(`${path}: still has scaffolded text from npm run new-plugin ("${phrase}"). Replace it with your plugin's real content.`);
    if (/^plugins\/[^/]+\/README\.md$/.test(path) && !/^## Host checks\s*$/m.test(await readFile(file, "utf8"))) {
      warnings.push(`${path}: add a "## Host checks" section listing what to try by hand in each host before a release. See docs/local-development.md#before-a-release.`);
    }
  }
  if (!catalog || catalog.name === templateDefaults.marketplace) return warnings;
  let repo;
  try { repo = (await json(resolve(directory, "package.json"))).repository; } catch { repo = undefined; }
  for (const file of allFiles) {
    const path = relative(directory, file).split(sep).join("/");
    if (!path.endsWith(".md") || path.endsWith("CHANGELOG.md")) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const found = lines.findIndex((line) => /github\/plugin-marketplace-starter|@plugin-marketplace-starter\b|browse plugin-marketplace-starter\b/.test(line));
    if (found !== -1) warnings.push(`${path}:${found + 1}: still names the template's marketplace. Run npm run rename-marketplace, or update it by hand.`);
    if (repo && /^plugins\/[^/]+\/README\.md$/.test(path)) {
      const placeholder = lines.findIndex((line) => /\bOWNER\/REPO\b|@MARKETPLACE\b/.test(line));
      if (placeholder !== -1) warnings.push(`${path}:${placeholder + 1}: still has the OWNER/REPO or MARKETPLACE placeholder. Run npm run rename-marketplace, or fill it in by hand.`);
    }
  }
  const readme = await read(resolve(directory, "README.md"));
  if (readme?.startsWith("# Plugin marketplace starter") || readme?.replace(/\s+/g, " ").includes(templateIntroduction)) {
    warnings.push("README.md: the title or introduction is still the template's. Rewrite them for your marketplace.");
  }
  // MIT asks you to keep the original notice in copies, so the template's line
  // stays. This warns only while no one else is named in the root LICENSE, which
  // covers your plugins too, and not when the catalog owner is GitHub itself.
  const rootHolders = copyrightHolders(await read(resolve(directory, "LICENSE")));
  if (catalog.owner?.name !== templateDefaults.owner && rootHolders.length > 0 && rootHolders.every((holder) => holder === templateLicenseHolder)) {
    warnings.push(`LICENSE: names only ${templateLicenseHolder}, the template's holder. Keep that line, since you kept the template's code, and add a line for your own copyright. It covers every plugin in the repository. See Licensing in README.md.`);
  }
  if ((await read(resolve(directory, "SECURITY.md")))?.includes("Replace this section with your team's reporting channel")) {
    warnings.push("SECURITY.md: replace the placeholder reporting section with your real security contact.");
  }
  const owners = await read(resolve(directory, ".github/CODEOWNERS"));
  if (owners !== undefined && !owners.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith("#"))) {
    warnings.push(".github/CODEOWNERS: every rule is commented out. Name real owners, then require their review in a ruleset.");
  }
  return warnings;
}

const plural = (number, noun) => `${number} ${noun}${number === 1 ? "" : "s"}`;

async function validatePlugin(directory, entry, problems, counts) {
  const label = `plugins/${entry.source.slice("./plugins/".length)}`;
  const source = await problems.check(label, () => contained(resolve(directory, "plugins"), entry.source.slice("./plugins/".length)));
  if (!source) return;
  const manifest = await problems.check(`${label}/plugin.json`, () => json(resolve(source, "plugin.json")));
  if (manifest) {
    const where = `${label}/plugin.json`;
    problems.checkSync(where, () => assert.ok(validatePluginManifest(manifest), ajv.errorsText(validatePluginManifest.errors)));
    problems.checkSync(where, () => assert.equal(manifest.name, entry.name, `name "${manifest.name}" doesn't match the marketplace.json entry "${entry.name}".`));
    problems.checkSync(where, () => assert.equal(manifest.version, entry.version, `version ${manifest.version} doesn't match the marketplace.json entry (${entry.version}). Change both together.`));
    problems.checkSync(where, () => assert.equal(manifest.description, entry.description, "description must match the marketplace.json entry exactly."));
    problems.checkSync(where, () => assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "use a MAJOR.MINOR.PATCH version."));
    await problems.check(`${label}/CHANGELOG.md`, async () => assert.ok((await readFile(resolve(source, "CHANGELOG.md"), "utf8")).replaceAll("\r\n", "\n").includes(`## ${manifest.version}\n`),
      `needs a "## ${manifest.version}" heading for the current version.`));
  }
  await problems.check(`${label}/README.md`, () => stat(resolve(source, "README.md")));
  let assets = 0;
  const agents = new Set();
  for (const file of await files(source)) {
    const path = relative(source, file).split(sep).join("/");
    const where = `${label}/${path}`;
    await problems.check(where, async () => {
      assert.ok(![".plugin", ".claude-plugin"].some((name) => file.includes(`${sep}${name}${sep}`)), "Use the Agent Plugins 1.0 layout, not legacy .plugin/ or .claude-plugin/ directories.");
      if (path.endsWith("/SKILL.md") || path === "SKILL.md") {
        assets++;
        assert.match(path, /^skills\/[^/]+\/SKILL\.md$/, "skills belong in skills/<name>/SKILL.md.");
        const meta = frontmatter(await readFile(file, "utf8"), where);
        assert.equal(meta.name, path.split("/")[1], `skill name "${meta.name}" must match its directory "${path.split("/")[1]}".`);
        counts.skills++;
      }
      // A component file in the wrong place is a mistake worth naming. A file
      // inside a skill, such as references/example.agent.md, is just content,
      // and so is a file whose name only ends like a component's, such as
      // pre-commit-hooks.json or sample-mcp.json.
      const base = path.split("/").at(-1);
      if (!/^skills\/[^/]+\/./.test(path) || /^skills\/[^/]+\/SKILL\.md$/.test(path)) {
        if (base.endsWith(".agent.md")) assert.match(path, /^com\.github\.copilot\/agents\/[^/]+\.agent\.md$/, "agents belong in com.github.copilot/agents/.");
        if (base === "mcp.json") assert.equal(path, "mcp.json", "put MCP configuration in the plugin's root mcp.json.");
        if (base === "hooks.json") assert.equal(path, "com.github.copilot/hooks/hooks.json", "put hooks in com.github.copilot/hooks/hooks.json.");
        if (base === "lsp.json") assert.equal(path, "com.github.copilot/lsp.json", "put LSP servers in com.github.copilot/lsp.json.");
      }
      if (path.startsWith("com.github.copilot/agents/")) {
        assets++;
        assert.match(path, /^com\.github\.copilot\/agents\/[^/]+\.agent\.md$/, "com.github.copilot/agents/ holds only <name>.agent.md files.");
        const meta = frontmatter(await readFile(file, "utf8"), where);
        assert.equal(`${meta.name}.agent.md`, path.split("/").at(-1), `agent name "${meta.name}" must match its file name.`);
        assert.ok(!agents.has(meta.name), "duplicate agent name.");
        assert.ok(meta.tools === undefined || (Array.isArray(meta.tools) && meta.tools.every((tool) => typeof tool === "string" && tool)),
          "tools must be a list of names.");
        agents.add(meta.name);
        counts.agents++;
      }
      if (path === "mcp.json") {
        assets++;
        counts.mcpServers += await validateMcpConfig(source, entry.name);
      }
      if (path === "com.github.copilot/hooks/hooks.json") {
        assets++;
        const hooks = await json(file);
        assert.equal(hooks.version, 1, "set version to 1.");
        assert.ok(hooks.hooks && Object.keys(hooks.hooks).length, "declare at least one hook event under hooks.");
        for (const [event, commands] of Object.entries(hooks.hooks)) {
          assert.ok(hookEvents.includes(event), `Unsupported hook event: ${event}. Use a documented event name: ${hookEvents.join(", ")}.`);
          assert.ok(Array.isArray(commands) && commands.length, `${event}: list at least one command.`);
          for (const hook of commands) {
            assert.equal(hook.type, "command", `${event}: hook type must be "command".`);
            assert.ok(Number.isFinite(hook.timeoutSec) && hook.timeoutSec > 0, `${event}: set a positive timeoutSec.`);
            const script = hook.command?.match(/^node "\$\{PLUGIN_ROOT\}\/([^"]+)"(?:\s+\S.*)?$/)?.[1];
            assert.ok(script, `run hooks as node "\${PLUGIN_ROOT}/<script>", optionally followed by arguments.`);
            await contained(source, script);
          }
          counts.hooks++;
        }
      }
      if (/^com\.github\.copilot\/extensions\/[^/]+\/extension\.mjs$/.test(path)) assets++;
      // Slash commands and rules: Copilot documents their directories but not a
      // file format, so check only that each shipped file has content.
      const component = path.match(/^com\.github\.copilot\/(commands|rules)\/(?:.+\/)?[^/.][^/]*$/)?.[1];
      if (component) {
        assets++;
        assert.ok((await readFile(file, "utf8")).trim(), `${entry.name}: ${path} is empty.`);
        counts[component]++;
      }
      if (path === "com.github.copilot/lsp.json") {
        assets++;
        counts.lspServers += validateLspConfig(await json(file), entry.name);
      }
    });
  }
  if (!assets) problems.add(label, `${entry.name}: plugin has no supported assets. Add a skill, agent, hook, MCP server, command, rule, LSP server, or extension.`);
  counts.plugins++;
}

export async function validateRepository(directory = root) {
  const problems = new Problems(directory);
  const parsed = await problems.check("marketplace.json", () => readCatalog(directory));
  problems.throwIfAny();
  const { catalog, localPlugins, remotePlugins } = parsed;
  const names = new Set(localPlugins.map((entry) => entry.name));
  const counts = { plugins: 0, skills: 0, agents: 0, hooks: 0, mcpServers: 0, commands: 0, rules: 0, lspServers: 0 };
  for (const entry of localPlugins) await validatePlugin(directory, entry, problems, counts);
  await problems.check("plugins/", async () => {
    const actual = await pluginDirectories(directory);
    const unregistered = actual.filter((name) => !names.has(name)).sort();
    assert.ok(!unregistered.length, `Every plugin must be registered in marketplace.json. Not listed: ${unregistered.join(", ")}.`);
  });
  await problems.check(".github/copilot/settings.json", async () => {
    const settings = await json(resolve(directory, ".github/copilot/settings.json"));
    assert.deepEqual(settings.extraKnownMarketplaces, {
      [catalog.name]: { source: { source: "directory", path: "." } },
    }, `The repository marketplace must point at this checkout: set extraKnownMarketplaces to { "${catalog.name}": { "source": { "source": "directory", "path": "." } } }.`);
    const expected = [...names].map((name) => `${name}@${catalog.name}`).sort();
    const actual = Object.keys(settings.enabledPlugins ?? {}).sort();
    assert.ok(expected.every((key) => settings.enabledPlugins?.[key] === true) && actual.length === expected.length,
      `Enable every local plugin in the repository overlay, and nothing else. Expected enabledPlugins keys: ${expected.join(", ")}; found: ${actual.join(", ") || "none"}. `
      + "Never enable a remote plugin there: checking out this repository must not activate code fetched from another repository, so developers install remote plugins themselves.");
  });
  await problems.check(".vally.yaml", () => validateVallySkillPaths(directory, localPlugins));
  const allFiles = await files(directory);
  for (const file of allFiles) {
    const path = relative(directory, file).split(sep).join("/");
    if (/\.(?:mjs|js)$/.test(file)) {
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (check.status !== 0) problems.add(path, (check.stderr || check.error?.message || "JavaScript syntax check failed.").trim());
    }
    if (file.endsWith(".md")) {
      for (const link of markdownLinks(await readFile(file, "utf8"))) {
        const target = resolve(file, "..", link.split("#")[0]);
        try { await stat(target); }
        catch { problems.add(path, `broken relative link ${link}`); }
      }
    }
  }
  problems.throwIfAny();
  const warnings = [...remotePlugins.flatMap(remoteWarnings), ...await staleReferenceWarnings(directory, catalog, allFiles)];
  return { ...counts, remotePlugins: remotePlugins.length, warnings };
}

if (isEntrypoint(import.meta.url)) {
  await runCli(async () => {
    const counts = await validateRepository();
    const parts = [plural(counts.skills, "skill"), plural(counts.agents, "agent"), plural(counts.hooks, "hook event"), plural(counts.mcpServers, "MCP server")];
    for (const [key, noun] of [["commands", "command file"], ["rules", "rule file"], ["lspServers", "LSP server"]]) if (counts[key]) parts.push(plural(counts[key], noun));
    console.log(`Validated ${plural(counts.plugins, "local plugin")}: ${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}.`);
    if (!counts.plugins) console.log("There are no local plugins yet. Add one with npm run new-plugin -- <name>.");
    console.log(`Validated ${plural(counts.remotePlugins, "remote reference")} as metadata only; no upstream code was fetched or run.`);
    for (const warning of counts.warnings) console.warn(`Warning: ${warning}`);
  });
}