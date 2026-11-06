import { isEntrypoint } from "./entrypoint.mjs";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { namePattern } from "./catalog.mjs";
import { repositoryName } from "./new-plugin.mjs";
import { runCli } from "./problems.mjs";
import { templateDefaults } from "./validate.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Usage: npm run rename-marketplace -- --name <name> --owner <owner> --repo <OWNER/REPO> [--dry-run]

Renames the marketplace everywhere it appears:

- name and owner.name in marketplace.json
- the marketplace key and every <plugin>@<marketplace> key in
  .github/copilot/settings.json
- name and repository in package.json, and name in package-lock.json
- install commands, OWNER/REPO and MARKETPLACE placeholders, and the template's
  own name in Markdown files, including plugin READMEs
- the README title, if it's still the template's, and sections marked
  <!-- template-only --> that describe the template itself

  --name <name>        The new marketplace name: lowercase letters, digits, and
                       single hyphens, such as my-team-plugins.
  --owner <owner>      The person, team, or organization that maintains it.
  --repo <OWNER/REPO>  The GitHub repository that hosts it, such as my-org/plugins.
  --dry-run            List the files that would change without changing them.

It doesn't change LICENSE; decide on the copyright holder yourself.
npm run verify warns about anything left over.`;

const skipped = new Set([".git", "node_modules", "vally-results", ".vally", ".copilot-home", "dist"]);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const writeJson = (path, value) => `${JSON.stringify(value, null, 2)}\n`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const title = (name) => name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
export const templateTitle = "# Plugin marketplace starter";

async function markdownFiles(directory) {
  const found = [];
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".md") && entry.name !== "CHANGELOG.md") found.push(child);
    }
  }
  await walk(directory);
  return found;
}

// Rewrites one Markdown file for the new names. Plugin READMEs use OWNER/REPO
// and MARKETPLACE placeholders with a sentence that explains them; with real
// values in place, that sentence goes too.
export function renameMarkdown(text, { from, to }) {
  let next = text.replace(/\r\n/g, "\n");
  if (from.repo) next = next.replace(new RegExp(`(?<![\\w./-])${escape(from.repo)}(?![\\w-])`, "g"), to.repo);
  next = next.replace(new RegExp(`(copilot plugin install [a-z0-9-]+@)${escape(from.name)}(?![\\w-])`, "g"), `$1${to.name}`)
    .replace(new RegExp(`(copilot plugin marketplace browse )${escape(from.name)}(?![\\w-])`, "g"), `$1${to.name}`)
    .replace(new RegExp(`@${escape(from.name)}(?![\\w-])`, "g"), `@${to.name}`)
    .replace(/^(copilot plugin marketplace add )OWNER\/REPO\s*$/gm, `$1${to.repo}`)
    .replace(/^(copilot plugin install [a-z0-9-]+@)MARKETPLACE\s*$/gm, `$1${to.name}`)
    .replace(/\nReplace `OWNER\/REPO` with the GitHub repository that hosts this marketplace\nand `MARKETPLACE` with the `name` in its `marketplace\.json`\.( See\n)?/g, (match, see) => see ? "\nSee\n" : "\n")
    .replace(/\nReplace `OWNER\/REPO` with the GitHub repository that hosts this marketplace\.\n/g, "\n");
  const lines = [];
  let skipping = false;
  for (const line of next.split("\n")) {
    if (/^\s*<!--\s*template-only\s*-->\s*$/.test(line)) { skipping = true; continue; }
    if (/^\s*<!--\s*\/template-only\s*-->\s*$/.test(line)) { skipping = false; continue; }
    if (!skipping) lines.push(line);
  }
  next = lines.join("\n");
  if (next.startsWith(`${templateTitle}\n`)) next = `# ${title(to.name)}\n${next.slice(templateTitle.length + 1)}`;
  return next;
}

export async function renameMarketplace({ name, owner, repo, directory = root, dryRun = false }) {
  if (!namePattern.test(name ?? "") || name.length > 64) throw new Error(`--name "${name ?? ""}" must be lowercase letters, digits, and single hyphens, such as my-team-plugins.`);
  if (typeof owner !== "string" || !owner.trim()) throw new Error("--owner is required, such as --owner \"My Team\".");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo ?? "")) throw new Error(`--repo "${repo ?? ""}" must be OWNER/REPO, such as my-org/plugins.`);
  const changes = new Map();
  const catalogPath = resolve(directory, "marketplace.json");
  const catalog = await json(catalogPath);
  const manifestPath = resolve(directory, "package.json");
  const manifest = existsSync(manifestPath) ? await json(manifestPath) : undefined;
  const from = {
    name: catalog.name,
    repo: repositoryName(manifest) ?? (catalog.name === templateDefaults.marketplace ? "github/plugin-marketplace-starter" : undefined),
  };
  const to = { name, repo };
  changes.set(catalogPath, writeJson(catalogPath, { ...catalog, name, owner: { ...catalog.owner, name: owner.trim() } }));

  const settingsPath = resolve(directory, ".github/copilot/settings.json");
  if (existsSync(settingsPath)) {
    const settings = await json(settingsPath);
    const rename = (key) => key === from.name ? name : key.endsWith(`@${from.name}`) ? `${key.slice(0, -from.name.length)}${name}` : key;
    const renamed = { ...settings };
    if (settings.extraKnownMarketplaces) renamed.extraKnownMarketplaces = Object.fromEntries(Object.entries(settings.extraKnownMarketplaces).map(([key, value]) => [rename(key), value]));
    if (settings.enabledPlugins) renamed.enabledPlugins = Object.fromEntries(Object.entries(settings.enabledPlugins).map(([key, value]) => [rename(key), value]));
    changes.set(settingsPath, writeJson(settingsPath, renamed));
  }

  if (manifest) {
    const { name: _, repository: __, ...rest } = manifest;
    changes.set(manifestPath, writeJson(manifestPath, { name, ...rest, repository: { type: "git", url: `https://github.com/${repo}` } }));
    const lockPath = resolve(directory, "package-lock.json");
    if (existsSync(lockPath)) {
      const lock = await json(lockPath);
      lock.name = name;
      if (lock.packages?.[""]) lock.packages[""].name = name;
      changes.set(lockPath, writeJson(lockPath, lock));
    }
  }

  for (const file of await markdownFiles(directory)) {
    const text = await readFile(file, "utf8");
    const next = renameMarkdown(text, { from, to });
    if (next !== text.replace(/\r\n/g, "\n")) changes.set(file, next);
  }
  const changed = [];
  for (const [path, text] of changes) {
    const current = existsSync(path) ? (await readFile(path, "utf8")).replace(/\r\n/g, "\n") : undefined;
    if (current === text) continue;
    changed.push(path.slice(resolve(directory).length + 1).split(sep).join("/"));
    if (!dryRun) await writeFile(path, text);
  }
  return { from, to, changed };
}

if (isEntrypoint(import.meta.url)) {
  await runCli(async () => {
    let parsed;
    try {
      parsed = parseArgs({ options: {
        name: { type: "string" }, owner: { type: "string" }, repo: { type: "string" },
        "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" },
      } });
    } catch (error) {
      throw new Error(`${error.message}. Run npm run rename-marketplace -- --help for the options.`);
    }
    const { values } = parsed;
    if (values.help || !values.name) {
      console.log(usage);
      if (!values.help) process.exitCode = 1;
      return;
    }
    const result = await renameMarketplace({ ...values, dryRun: values["dry-run"] });
    console.log(`${values["dry-run"] ? "Would rename" : "Renamed"} ${result.from.name} to ${result.to.name}${values["dry-run"] ? ", changing" : ". Changed"}:`);
    for (const path of result.changed) console.log(`  ${path}`);
    if (values["dry-run"]) return;
    console.log("\nNext: rewrite the README's introduction for your marketplace, and add your own copyright line to the root LICENSE (keep the template's line). That one LICENSE covers every plugin. Then run npm run verify. It warns about anything left over.");
  });
}
