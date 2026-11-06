import { isEntrypoint } from "./entrypoint.mjs";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { namePattern, readCatalog } from "./catalog.mjs";
import { runCli } from "./problems.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const components = ["agent", "mcp", "hook", "extension"];
const usage = `Usage: npm run new-plugin -- <name> [--with <type>]... [--no-skill] [--description "What it does."]

Scaffolds plugins/<name>/ with a skill, README, and CHANGELOG, plus
evals/<name>/eval.yaml, and registers the plugin in marketplace.json,
.github/copilot/settings.json, .vally.yaml, and the README's plugin table and
install commands. npm run verify passes right away.

  --with agent       Also add a read-only custom agent, <name>-specialist, and its
                     delegation eval. The plugin name can then have at most 53
                     characters.
  --with mcp         Also add a local stdio MCP server (src/server.ts) with one tool.
  --with hook        Also add a postToolUse hook, its eval, and a model-free test
                     in test/<name>-hook.test.mjs.
  --with extension   Also add a canvas extension, its eval through the shared
                     headless canvas host, and its grader in evals/graders/<name>.mjs.
  --no-skill         Leave out the skill, for example for a hook-only plugin.
                     Add at least one --with type.`;

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const title = (name) => name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
const paramName = (name) => `${name.toUpperCase().replaceAll("-", "_")}_MCP_SERVER`;
const extensionParam = (name) => `${name.toUpperCase().replaceAll("-", "_")}_EXTENSION`;
const editTools = ["apply_patch", "create", "edit", "create_file", "replace_string_in_file", "multi_replace_string_in_file"];

// OWNER/REPO from package.json "repository", which npm run rename-marketplace sets.
export function repositoryName(manifest) {
  const value = typeof manifest?.repository === "string" ? manifest.repository : manifest?.repository?.url;
  return value?.match(/^(?:github:)?([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)?.[1]
    ?? value?.match(/github\.com[/:]([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)?.[1];
}

async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

function skillFile(name, description, { agent, mcp, extension }) {
  return `---
name: ${name}
description: ${JSON.stringify(`${description} Use when the user asks for ${name} help. Replace this description with the real trigger: say when to use the skill and when not to.`)}
---

# ${title(name)}

Replace these instructions with your team's procedure. Keep this file short and
move detail into a \`references/\` folder that the skill reads when it needs it.

1. Start your reply with the line \`${name}: ready\` so evals can confirm the skill ran.
2. Do the task the user asked for. Ask for missing details instead of inventing them.
${agent ? `3. For a deeper review, delegate to the \`${agent}\` custom agent.\n` : ""}${mcp ? `${agent ? 4 : 3}. Use the \`echo\` tool from the \`${name}\` MCP server when the user asks you to echo text, and report its result.\n` : ""}${extension ? `${3 + Boolean(agent) + Boolean(mcp)}. When the user wants a shared list, open the \`${name}\` canvas and use its \`get_items\` and \`add_item\` actions. If this host can't show canvases, keep the list in chat and say so.\n` : ""}`;
}

function agentFile(agent, name) {
  return `---
name: ${agent}
description: ${JSON.stringify(`Read-only specialist for ${name} tasks. Replace this description with when the main agent should delegate to it.`)}
tools: ["read", "search"]
---

Replace these instructions with the specialist's role. Start your reply with the
line \`${agent}: ready\` so evals can confirm this agent ran.

You are read-only. Don't edit files or run commands.
`;
}

function serverFile(name) {
  return `import { realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Replaced at build time with the version in plugin.json.
declare const __PLUGIN_VERSION__: string;

// Replace this example tool with your own. Servers must start offline, without
// credentials or network access; put anything that needs a secret in a tool call.
export function createServer(): McpServer {
  const server = new McpServer({ name: '${name}', version: __PLUGIN_VERSION__ });
  server.registerTool('echo', {
    title: 'Echo text',
    description: 'Return the supplied text unchanged as {text}. No files, network, or persistence.',
    inputSchema: { text: z.string().max(10_000).describe('Text to return.') },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, ({ text }) => ({ content: [{ type: 'text', text: JSON.stringify({ text }) }], structuredContent: { text } }));
  return server;
}

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};
const entrypoint = process.argv[1];
if (entrypoint && relative(realPath(entrypoint), realPath(fileURLToPath(import.meta.url))) === '') {
  createServer().connect(new StdioServerTransport()).catch(error => {
    console.error('Failed to start the ${name} MCP server:', error);
    process.exitCode = 1;
  });
}
`;
}

function hookFile(name) {
  return `import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A postToolUse hook. Copilot passes the event as JSON on stdin and reads a JSON
// result from stdout. docs/hooks.md describes the event fields.
const editTools = new Set(${JSON.stringify(editTools)});

export function handle(event) {
  if (!event || typeof event.toolName !== "string") return { additionalContext: "${name}: Expected a Copilot CLI tool event." };
  if (!editTools.has(event.toolName) || event.toolResult?.resultType !== "success") return {};
  // Replace this with the hook's real work. Start every message with "${name}:"
  // so evals can tell that the hook ran, and never return a permission decision.
  return { additionalContext: \`${name}: saw a successful \${event.toolName} edit.\` };
}

// Compare real paths: Node resolves import.meta.url through symlinks but not argv.
const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  let result;
  try {
    result = handle(JSON.parse(readFileSync(0, "utf8")));
  } catch {
    // Don't echo the input: it can hold file contents.
    result = { additionalContext: "${name}: Hook input isn't valid JSON." };
  }
  process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
}
`;
}

function hookTest(name) {
  return `import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Model-free checks for the ${name} hook. They run the script the way Copilot
// does: the event on stdin, a JSON result on stdout.
const hook = fileURLToPath(new URL("../plugins/${name}/com.github.copilot/hooks/${name}.mjs", import.meta.url));
function run(input) {
  const result = spawnSync(process.execPath, [hook], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(Object.keys(output).every((key) => key === "additionalContext"), "Hooks here never return permission decisions.");
  return output;
}
const event = (toolName, resultType = "success") => ({ cwd: process.cwd(), toolName, toolArgs: {}, toolResult: { resultType } });

test("${name} reports successful edits with its own prefix", () => {
  assert.match(run(event("apply_patch")).additionalContext, /^${name}: /);
});

test("${name} ignores failed edits and other tools, and reports bad input without echoing it", () => {
  assert.deepEqual(run(event("apply_patch", "failure")), {});
  assert.deepEqual(run(event("bash")), {});
  const bad = run("{ SYNTHETIC_SECRET");
  assert.match(bad.additionalContext, /^${name}: /);
  assert.doesNotMatch(bad.additionalContext, /SYNTHETIC/);
});
`;
}

function extensionFile(name) {
  return `import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";

// A canvas with one list per session, kept in memory. The host provides
// @github/copilot-sdk/extension; don't install it into the plugin. Replace the
// actions and the page with your own. docs/customization-types.md explains
// where canvases work.
const lists = new Map();
const panels = new Map();
const title = ${JSON.stringify(title(name))};

function listFor(ctx) {
  if (!ctx.sessionId) throw new CanvasError("missing_session", "A session ID is required.");
  if (!lists.has(ctx.sessionId)) lists.set(ctx.sessionId, []);
  return lists.get(ctx.sessionId);
}

const escape = (text) => text.replace(/[&<>"']/g, (character) => \`&#\${character.charCodeAt(0)};\`);

// A read-only page on 127.0.0.1 under a random path, so other local processes
// can't find it by port alone. It checks Host to block DNS rebinding.
async function startServer(ctx) {
  const token = randomBytes(16).toString("hex");
  const server = createServer((request, response) => {
    const port = server.address().port;
    if (request.method !== "GET" || request.headers.host !== \`127.0.0.1:\${port}\` || request.url !== \`/\${token}/\`) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      return response.end("Not found.");
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "X-Content-Type-Options": "nosniff",
    });
    const items = listFor(ctx).map((item) => \`<li>\${escape(item)}</li>\`).join("");
    response.end(\`<!doctype html><meta charset="utf-8"><title>\${title}</title><h1>\${title}</h1><ul>\${items}</ul><p>Reload to see changes.</p>\`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: \`http://127.0.0.1:\${server.address().port}/\${token}/\`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const session = await joinSession({
  canvases: [createCanvas({
    id: ${JSON.stringify(name)},
    displayName: title,
    description: "A shared list that a person and Copilot both see.",
    actions: [
      { name: "get_items", description: "Read every item on this session's list.", handler: async (ctx) => ({ items: [...listFor(ctx)] }) },
      {
        name: "add_item",
        description: "Add one short item to the list.",
        inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string", minLength: 1, maxLength: 200 } }, required: ["text"] },
        handler: async (ctx) => {
          const list = listFor(ctx);
          const text = String(ctx.input?.text ?? "").trim();
          if (!text) throw new CanvasError("invalid_item", "Give the item some text.");
          if (list.length >= 50) throw new CanvasError("list_full", "The list holds at most 50 items.");
          list.push(text);
          return { items: [...list] };
        },
      },
    ],
    async open(ctx) {
      const key = JSON.stringify([ctx.sessionId, ctx.instanceId]);
      if (!panels.has(key)) panels.set(key, startServer(ctx));
      try {
        return { title, url: (await panels.get(key)).url };
      } catch (error) {
        panels.delete(key);
        throw new CanvasError("server_failed", \`Could not open the list: \${error.message}\`);
      }
    },
    async onClose(ctx) {
      const key = JSON.stringify([ctx.sessionId, ctx.instanceId]);
      const panel = panels.get(key);
      panels.delete(key);
      if (panel) await (await panel).close();
    },
  })],
});
await session.log(\`\${title} ready. The list is session-only.\`);
`;
}

function graderFile(name) {
  return `import { calls, check, isMain, payload, runGrade } from "./common.mjs";

// Grades the ${name} canvas eval from the real extension's results, not from
// what the model says it did.
export const seedItem = "Existing item";
export const newItem = "Ship the first draft";

export function assessList(trajectory) {
  const opened = calls(trajectory, "open_canvas").filter((call) => call.success);
  const actions = calls(trajectory, "invoke_canvas_action").filter((call) => call.success)
    .map((call) => ({ ...call, value: payload(call) }));
  const added = actions.filter((call) => call.args?.actionName === "add_item");
  const final = actions.filter((call) => call.args?.actionName === "get_items").at(-1)?.value?.board?.items;
  return [
    check("Must open the canvas.", opened.length > 0),
    check("Must add exactly the requested item.", added.length === 1 && added[0].args?.input?.text === newItem),
    check("Must keep the seeded item and read the final list.", Array.isArray(final) && final.includes(seedItem) && final.includes(newItem)),
  ];
}

if (isMain(import.meta.url)) await runGrade("${name}-canvas", (trajectory) => assessList(trajectory));
`;
}

function readmeFile(name, description, marketplace, repo, { skill, agent, mcp, hook, extension }) {
  const parts = [skill && "a skill", agent && "a read-only custom agent", mcp && "a local MCP server", hook && "a `postToolUse` hook", extension && "a canvas extension"].filter(Boolean);
  const checks = [
    skill && `- Ask for help with a ${name.replaceAll("-", " ")} task and confirm the \`${name}\` skill runs.`,
    agent && `- Ask for a deeper review and confirm the \`${name}-specialist\` agent runs and edits nothing.`,
    mcp && "- Ask Copilot to echo some text and confirm the `echo` tool runs.",
    hook && `- Edit a file with a single edit, a multi-file edit, and \`apply_patch\`, and confirm the \`${name}:\` message appears after each. Confirm a failed edit and an unrelated tool don't trigger it.`,
    extension && `- Open the \`${name}\` canvas, add an item from chat, and reload the panel to see it. Close and reopen the panel and confirm the item stays; a new session starts empty. In a host without canvases, confirm the skill keeps the list in chat.`,
  ].filter(Boolean);
  return `# ${title(name)}

${description}

This plugin ships ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}. Replace the scaffolded
instructions${mcp ? " and the example `echo` tool" : ""}${hook ? " and hook script" : ""}${extension ? " and canvas" : ""} with your team's own, and update
[its evals](../../evals/${name}/eval.yaml) to check the real behavior.

## Install

\`\`\`sh
copilot plugin marketplace add ${repo ?? "OWNER/REPO"}
copilot plugin install ${name}@${marketplace}
\`\`\`
${repo ? "" : "\nReplace `OWNER/REPO` with the GitHub repository that hosts this marketplace.\n"}${mcp || hook || extension ? "\nIt needs Node.js 22.14 or newer on the machine running Copilot.\n" : ""}
## Try it

> ${skill ? `Use the ${name} skill to help with my task.` : extension ? `Open the ${name} canvas and add an item.` : "Edit any file, then look for the hook's message."}

## Host checks

Before a release, try these by hand in each host you support. Automated tests
and evals don't prove that a host loads or shows everything.

${checks.join("\n")}
`;
}

function evalFile(name, { skill, agent, mcp, hook, extension }) {
  const param = paramName(name);
  const lines = [
    `# Behavioral evals for the ${name} plugin. Replace the prompts and graders with`,
    "# your plugin's real behavior. npm run eval:check needs, for every asset, a",
    "# positive case that asserts invocation and outcome, one positive case tagged",
    "# suite: smoke, and a negative case with an observable assertion.",
    `name: ${name}`,
    `description: Scaffolded checks for the ${name} plugin.`,
    "type: capability",
    "defaults:",
    "  executor: copilot-sdk",
    "  model: gpt-5.4-mini",
    "  timeout: 2m",
    "  runs: 1",
  ];
  if (skill || mcp || agent) lines.push("agent_environment:");
  if (skill) lines.push("  skills:", `    - ../../plugins/${name}/skills/${name}`);
  // Every case, including the negative control, sees the agent profile, so the
  // negative case proves the agent isn't used when it's available.
  if (agent) {
    lines.push("  files:", `    - src: ../../plugins/${name}/com.github.copilot/agents/${agent}.agent.md`, `      dest: .github/agents/${agent}.agent.md`);
  }
  if (mcp) {
    lines.push(
      "  mcpServers:",
      `    ${name}:`,
      "      type: stdio",
      "      command: node",
      `      args: ['\${${param}}']`,
    );
  }
  if (extension) lines.push("grading_environment:", "  files:", "    - src: ../graders", "      dest: .grading");
  lines.push("stimuli:");
  if (skill) {
    lines.push(
      `  - name: ${name}-does-the-task`,
      `    prompt: Use the ${name} skill to help me with a small example task.`,
      "    tags:",
      `      assets: skill:${name}/${name}`,
      "      suite: smoke",
      "      control: positive",
      "    graders:",
      "      - type: completed",
      "      - type: skill-invocation",
      "        config:",
      `          required: [${name}]`,
      "      - type: output-contains",
      "        config:",
      `          substring: "${name}: ready"`,
    );
  }
  const assets = [skill && `skill:${name}/${name}`, agent && `agent:${name}/${agent}`, mcp && `mcp:${name}/${name}/echo`,
    hook && `hook:${name}/postToolUse`, extension && `extension:${name}/${name}`].filter(Boolean);
  lines.push(
    `  - name: ${name}-ignores-unrelated-question`,
    "    prompt: What is two plus two? Reply with only the digit, without editing files.",
  );
  if (hook || extension) lines.push("    agent_environment:");
  if (hook) lines.push("      env:", `        STARTER_PLUGIN_DIRS: plugins/${name}`);
  if (extension) {
    lines.push("      mcpServers:", `        ${name}-host:`, "          type: stdio", "          command: node",
      `          args: ['\${CANVAS_HOST}', '\${${extensionParam(name)}}']`);
  }
  lines.push(
    "    tags:",
    `      assets: [${assets.join(", ")}]`,
    "      control: negative",
    "    graders:",
    "      - type: completed",
  );
  if (skill) lines.push("      - type: skill-invocation", "        config:", `          disallowed: [${name}]`);
  const disallowed = [agent && "'^task$'", mcp && "'(^|[./_-])echo$'", hook && `'^(${editTools.join("|")})$'`,
    extension && "'(^|[./_-])(open_canvas|invoke_canvas_action)$'"].filter(Boolean);
  if (disallowed.length) lines.push("      - type: tool-calls", "        config:", `          disallowed: [${disallowed.join(", ")}]`);
  lines.push("      - type: output-contains", "        config:", '          substring: "4"');
  if (agent) {
    lines.push(
      `  - name: ${name}-delegates-to-${agent}`,
      `    prompt: Delegate to the ${agent} specialist and report what it says. Don't edit files.`,
      "    tags:",
      `      assets: agent:${name}/${agent}`,
      "      suite: smoke",
      "      control: positive",
      "    graders:",
      "      - type: completed",
      "      - type: tool-calls",
      "        config:",
      "          required:",
      "            - name: ^task$",
      "              args:",
      `                agent_type: ^${agent}$`,
      "      - type: output-contains",
      "        scope: subagent",
      "        config:",
      `          substring: "${agent}: ready"`,
      "      - type: diff-empty",
    );
  }
  if (mcp) {
    lines.push(
      `  - name: ${name}-echoes-text`,
      `    prompt: ${skill ? `Use the ${name} skill and its` : "Use the"} echo tool to echo the text hello-${name}. Report the tool's result.`,
      "    tags:",
      `      assets: mcp:${name}/${name}/echo`,
      "      suite: smoke",
      "      control: positive",
      "    graders:",
      "      - type: completed",
      "      - type: tool-calls",
      "        config:",
      "          required:",
      "            - name: '(^|[./_-])echo$'",
      `              result: '"text"\\s*:\\s*"hello-${name}"'`,
      "      - type: output-contains",
      "        config:",
      `          substring: hello-${name}`,
    );
  }
  if (hook) {
    lines.push(
      `  - name: ${name}-hook-reports-edit`,
      "    prompt: >-",
      "      Use apply_patch to create notes.txt containing the single line hello.",
      "      Don't run shell commands. Then report any message the hook added.",
      "    agent_environment:",
      "      env:",
      "        # Mounts the real plugin with --plugin-dir through scripts/eval-runtime.js.",
      `        STARTER_PLUGIN_DIRS: plugins/${name}`,
      "    tags:",
      `      assets: hook:${name}/postToolUse`,
      "      suite: smoke",
      "      control: positive",
      "    graders:",
      "      - type: completed",
      "      - type: tool-calls",
      "        config:",
      "          # Only the hook writes this prefix into the edit's result, so it proves the hook ran.",
      "          required:",
      "            - name: ^apply_patch$",
      `              result: '${name}: '`,
      "          disallowed: ['^(bash|powershell|shell)$']",
    );
  }
  if (extension) {
    lines.push(
      `  - name: ${name}-canvas-adds-item`,
      "    prompt: >-",
      `      Use the ${name}-host tools to open the ${name} canvas with the instance handle main.`,
      '      Add the item "Ship the first draft", then read the list and report it. Don\'t edit files.',
      "    agent_environment:",
      "      mcpServers:",
      `        ${name}-host:`,
      "          type: stdio",
      "          command: node",
      "          # The shared headless host drives the real extension; the seed gives every session the same start.",
      "          args:",
      "            - '${CANVAS_HOST}'",
      `            - '\${${extensionParam(name)}}'`,
      "            - --seed",
      `            - '[{"action":"add_item","input":{"text":"Existing item"}}]'`,
      "    tags:",
      `      assets: extension:${name}/${name}`,
      "      suite: smoke",
      "      control: positive",
      "      boundary: headless-sdk-contract",
      "    graders:",
      "      - type: completed",
      "      - type: program",
      "        config:",
      "          program: node",
      `          args: [.grading/${name}.mjs]`,
      "      - type: diff-empty",
    );
  }
  lines.push("scoring:", "  threshold: 1", "");
  return lines.join("\n");
}

// Adds the plugin to the README's plugin table (marked with <!-- plugin-table -->)
// and its install commands, when the README still has them. Returns whether it
// changed anything.
export function addToReadme(text, { name, marketplace, description, tryIt }) {
  const lines = text.split(/\r?\n/);
  let changed = false;
  const marker = lines.findIndex((line) => line.trim() === "<!-- plugin-table -->");
  if (marker !== -1 && /^\s*\|/.test(lines[marker + 1] ?? "") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[marker + 2] ?? "")) {
    let end = marker + 3;
    while (/^\s*\|/.test(lines[end] ?? "")) end++;
    const rows = lines.slice(marker + 3, end).filter((line) => !line.includes("_None yet._"));
    const cell = (value) => value.replaceAll("|", "\\|");
    rows.push(`| [${name}](plugins/${name}/) | ${cell(tryIt)} | ${cell(description)} |`);
    lines.splice(marker + 3, end - marker - 3, ...rows);
    changed = true;
  }
  const install = new RegExp(`^copilot plugin install [a-z0-9-]+@${marketplace}\\s*$`);
  let at = lines.findLastIndex((line) => install.test(line));
  if (at === -1) at = lines.findIndex((line) => line.trim() === `copilot plugin marketplace browse ${marketplace}`);
  if (at !== -1) {
    lines.splice(at + 1, 0, `copilot plugin install ${name}@${marketplace}`);
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

export async function newPlugin(name, { components: requested = [], skill = true, description, directory = root } = {}) {
  if (!namePattern.test(name ?? "") || name.length > 64) {
    throw new Error(`Plugin name "${name ?? ""}" must be lowercase letters, digits, and single hyphens, such as release-notes.`);
  }
  const unknown = requested.filter((item) => !components.includes(item));
  if (unknown.length) throw new Error(`Unknown --with value: ${unknown.join(", ")}. Use ${components.join(", ")}.`);
  if (!skill && !requested.length) throw new Error("A plugin needs at least one asset. Drop --no-skill, or add --with agent, mcp, hook, or extension.");
  // Asset names share the 64-character limit, and the agent adds "-specialist".
  if (requested.includes("agent") && `${name}-specialist`.length > 64) {
    throw new Error(`With --with agent, the plugin name can have at most ${64 - "-specialist".length} characters, so its agent name, ${name}-specialist, fits the 64-character limit. Pick a shorter name.`);
  }
  const { catalog } = await readCatalog(directory);
  if (catalog.plugins.some((entry) => entry.name === name)) throw new Error(`marketplace.json already has a plugin named ${name}.`);
  for (const path of [`plugins/${name}`, `evals/${name}`]) {
    if (existsSync(resolve(directory, path))) throw new Error(`${path} already exists. Pick another name or remove it first.`);
  }
  const options = {
    skill,
    agent: requested.includes("agent") ? `${name}-specialist` : undefined,
    mcp: requested.includes("mcp"),
    hook: requested.includes("hook"),
    extension: requested.includes("extension"),
  };
  for (const path of [options.hook && `test/${name}-hook.test.mjs`, options.extension && `evals/graders/${name}.mjs`].filter(Boolean)) {
    if (existsSync(resolve(directory, path))) throw new Error(`${path} already exists. Pick another name or remove it first.`);
  }
  description ??= `Help with ${name.replaceAll("-", " ")} tasks.`;
  let manifest = {};
  try { manifest = await json(resolve(directory, "package.json")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const repo = repositoryName(manifest);
  const plugin = resolve(directory, "plugins", name);
  const created = [];
  const add = async (path, text) => { await write(resolve(directory, path), text); created.push(path); };

  await add(`plugins/${name}/plugin.json`, `${JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name, version: "0.1.0", description, license: "MIT",
  }, null, 2)}\n`);
  await add(`plugins/${name}/README.md`, readmeFile(name, description, catalog.name, repo, options));
  await add(`plugins/${name}/CHANGELOG.md`, "# Changelog\n\n## 0.1.0\n\n- Initial release.\n");
  if (options.skill) await add(`plugins/${name}/skills/${name}/SKILL.md`, skillFile(name, description, options));
  if (options.agent) await add(`plugins/${name}/com.github.copilot/agents/${options.agent}.agent.md`, agentFile(options.agent, name));
  if (options.mcp) {
    await add(`plugins/${name}/src/server.ts`, serverFile(name));
    await add(`plugins/${name}/mcp.json`, `${JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { [name]: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/dist/server.mjs"], cwd: "${PLUGIN_ROOT}" } },
    }, null, 2)}\n`);
  }
  if (options.hook) {
    await add(`plugins/${name}/com.github.copilot/hooks/hooks.json`, `${JSON.stringify({
      version: 1,
      hooks: { postToolUse: [{ type: "command", command: `node "\${PLUGIN_ROOT}/com.github.copilot/hooks/${name}.mjs"`, timeoutSec: 10 }] },
    }, null, 2)}\n`);
    await add(`plugins/${name}/com.github.copilot/hooks/${name}.mjs`, hookFile(name));
    await add(`test/${name}-hook.test.mjs`, hookTest(name));
  }
  if (options.extension) {
    await add(`plugins/${name}/com.github.copilot/extensions/${name}/extension.mjs`, extensionFile(name));
    await add(`evals/graders/${name}.mjs`, graderFile(name));
  }
  await add(`evals/${name}/eval.yaml`, evalFile(name, options));

  const catalogPath = resolve(directory, "marketplace.json");
  const rawCatalog = await json(catalogPath);
  const lastLocal = rawCatalog.plugins.findLastIndex((entry) => typeof entry.source === "string");
  rawCatalog.plugins.splice(lastLocal + 1, 0, { name, source: `./plugins/${name}`, version: "0.1.0", description });
  await writeJson(catalogPath, rawCatalog);

  const settingsPath = resolve(directory, ".github/copilot/settings.json");
  const settings = await json(settingsPath);
  settings.enabledPlugins = { ...settings.enabledPlugins, [`${name}@${catalog.name}`]: true };
  await writeJson(settingsPath, settings);

  const updated = ["marketplace.json", ".github/copilot/settings.json"];
  const vallyPath = resolve(directory, ".vally.yaml");
  const vally = parseDocument(await readFile(vallyPath, "utf8"));
  if (options.skill) {
    if (!vally.hasIn(["paths", "skills"]) || !vally.getIn(["paths", "skills"])?.items) vally.setIn(["paths", "skills"], vally.createNode([]));
    vally.addIn(["paths", "skills"], `plugins/${name}/skills`);
  }
  if (options.mcp) vally.setIn(["params", paramName(name)], `plugins/${name}/dist/server.mjs`);
  if (options.extension) {
    if (!vally.hasIn(["params", "CANVAS_HOST"])) vally.setIn(["params", "CANVAS_HOST"], "evals/support/canvas-host.mjs");
    vally.setIn(["params", extensionParam(name)], `plugins/${name}/com.github.copilot/extensions/${name}/extension.mjs`);
  }
  if (options.skill || options.mcp || options.extension) {
    await writeFile(vallyPath, vally.toString());
    updated.push(".vally.yaml");
  }

  const readmePath = resolve(directory, "README.md");
  if (existsSync(readmePath)) {
    const before = await readFile(readmePath, "utf8");
    const tryIt = options.skill ? `"Use the ${name} skill to help with my task"` : options.extension ? `"Open the ${name} canvas"` : "Edit any file";
    const after = addToReadme(before, { name, marketplace: catalog.name, description, tryIt });
    if (after !== before) {
      await writeFile(readmePath, after);
      updated.push("README.md");
    }
  }

  if (options.mcp) {
    const build = spawnSync(process.execPath, [resolve(directory, "scripts/build.mjs")], { cwd: directory, encoding: "utf8" });
    if (build.status !== 0) throw new Error(`npm run build failed for the new MCP server:\n${build.stderr || build.stdout}`);
    created.push(`plugins/${name}/dist/server.mjs`);
  }
  return { created, updated, plugin, options };
}

if (isEntrypoint(import.meta.url)) {
  await runCli(async () => {
    let parsed;
    try {
      parsed = parseArgs({ allowPositionals: true, options: {
        with: { type: "string", multiple: true, default: [] },
        "no-skill": { type: "boolean" },
        description: { type: "string" },
        help: { type: "boolean", short: "h" },
      } });
    } catch (error) {
      throw new Error(`${error.message}. Run npm run new-plugin -- --help for the options.`);
    }
    const { values, positionals } = parsed;
    if (values.help || positionals.length !== 1) {
      console.log(usage);
      if (!values.help) process.exitCode = 1;
      return;
    }
    const result = await newPlugin(positionals[0], {
      components: values.with.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean),
      skill: !values["no-skill"],
      description: values.description,
    });
    console.log(`Created plugin ${positionals[0]}:`);
    for (const path of result.created) console.log(`  ${path}`);
    console.log(`Updated ${result.updated.join(", ")}.`);
    console.log("\nNext: replace the scaffolded instructions, README, and eval prompts with your real ones, then run npm run verify.");
  });
}
