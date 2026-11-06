import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

// Every repository path that belongs to one shipped example, beyond the generic
// plugins/<name>/ and evals/<name>/ directories. `npm run remove-example` deletes
// these, and example-only tests skip when the files they need are gone.
// Keep this map in step when you add a test, grader, fixture, or param for an example.
export const examples = Object.freeze({
  "bug-report": {
    paths: ["evals/graders/bug-report.mjs", "test/grader-bug-report.test.mjs"],
    params: [],
  },
  "team-brainstorm": {
    paths: [
      "evals/graders/brainstorm.mjs",
      "test/board.test.mjs",
      "test/board-ui.test.mjs",
      "test/brainstorm-eval-host.test.mjs",
      "test/extension.test.mjs",
      "test/grader-brainstorm.test.mjs",
    ],
    params: ["BRAINSTORM_EXTENSION"],
  },
  "format-json": {
    paths: ["evals/graders/format-json.mjs", "test/hook.test.mjs", "test/grader-format-json.test.mjs"],
    params: [],
  },
  "customization-authoring": {
    paths: ["evals/graders/src/authoring.mjs", "evals/graders/dist/authoring.mjs", "test/authoring-grader.test.mjs"],
    params: ["MARKETPLACE_VALLY_CLI"],
  },
  "code-review": {
    paths: ["evals/fixtures/review"],
    params: [],
  },
  "json-configuration": {
    paths: ["test/json-tools.test.mjs", "test/mcp-protocol.test.mjs"],
    params: ["JSON_MCP_SERVER"],
  },
});

// Repository tooling that no plugin owns, even when a plugin's name would match
// the naming convention below.
export const protectedPaths = new Set([
  "evals/graders/common.mjs",
  "evals/support/canvas-host.mjs",
  "evals/support/canvas-loader.mjs",
  "evals/support/canvas-sdk.mjs",
  ...["adoption", "canvas-host", "catalog", "eval-setup", "grader-common", "installation", "marketplace",
    "new-plugin", "remote-plugins", "rename-marketplace", "runtime-environment"].map((name) => `test/${name}.test.mjs`),
]);

// The paths a plugin owns: its directory, its evals directory, support files
// named after it, and for a shipped example, the extra files listed above.
// Support files follow a naming convention, so `npm run remove-plugin` can find
// the graders, eval hosts, fixtures, and tests of plugins you add:
// evals/graders/<name>.mjs, evals/graders/<name>-*.mjs, the bundled grader pair
// evals/graders/src/<name>.mjs and evals/graders/dist/<name>.mjs (or <name>-*.mjs),
// evals/support/<name>-*, evals/fixtures/<name>/, test/<name>.test.mjs, and test/<name>-*.test.mjs. A
// file whose name also fits a longer plugin name in `others`, such as
// test/bug-report.test.mjs for a plugin named bug, belongs to that plugin.
export async function ownedPaths(name, { directory = root, others = [] } = {}) {
  const longer = others.filter((other) => other !== name && other.startsWith(`${name}-`));
  const mine = (base) => (base === name || base.startsWith(`${name}-`))
    && !longer.some((other) => base === other || base.startsWith(`${other}-`));
  const conventional = [];
  for (const [folder, suffix] of [["evals/graders", ".mjs"], ["evals/graders/src", ".mjs"], ["evals/graders/dist", ".mjs"],
    ["evals/support", ""], ["evals/fixtures", ""], ["test", ".test.mjs"]]) {
    let entries = [];
    try { entries = await readdir(resolve(directory, folder), { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const entry of entries) {
      if (protectedPaths.has(`${folder}/${entry.name}`)) continue;
      if (folder === "evals/fixtures" ? !entry.isDirectory() || entry.name !== name : !entry.name.endsWith(suffix)) continue;
      const base = suffix ? entry.name.slice(0, -suffix.length) : entry.name.replace(/\.[^.]+$/, "");
      if (folder === "evals/fixtures" || mine(base)) conventional.push(`${folder}/${entry.name}`);
    }
  }
  return [...new Set([`plugins/${name}`, `evals/${name}`, ...(examples[name]?.paths ?? []), ...conventional])];
}

// Shipped examples whose plugin directory is still here.
export function presentExamples(directory = root) {
  return Object.keys(examples).filter((name) => existsSync(resolve(directory, "plugins", name)));
}

// Returns a skip reason when any of the files a test needs is missing, so
// example-only tests skip cleanly after you remove that example.
export function missing(...paths) {
  const gone = paths.filter((path) => !existsSync(resolve(root, path)));
  return gone.length ? `${gone.join(", ")} not found; this example was removed` : false;
}
