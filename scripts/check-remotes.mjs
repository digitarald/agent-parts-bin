import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readCatalog } from "./catalog.mjs";
import { runCli } from "./problems.mjs";
import { isEntrypoint } from "./entrypoint.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const usage = `Usage: npm run check-remotes [-- <name>...]

Checks each remote plugin in marketplace.json against GitHub. It uses the
network, so npm run verify doesn't run it. For each remote entry it confirms:

- the repository and the pinned sha exist
- plugin.json exists at the pinned sha under "path" (or the repository root)
- its name matches the catalog entry, and its version matches "version"

It also reports when "ref" now points at a different commit than the pin, and
when the repository has a newer release, so you can decide whether to update.

It authenticates with GH_TOKEN or GITHUB_TOKEN, or the GitHub CLI's login
(gh auth token). Private repositories need a token that can read them.`;

// Where Copilot CLI looks for a legacy plugin manifest, in its documented order
// (CLI plugin reference, File locations). An Agent Plugins plugin.json at the
// plugin root takes precedence over all of them.
export const legacyManifestPaths = Object.freeze([".plugin/plugin.json", "plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json"]);
const agentPluginsSchema = /^https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json$/;
const isAgentPluginsManifest = (data) => typeof data?.$schema === "string" && agentPluginsSchema.test(data.$schema);

function token() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// A small GitHub REST client: returns { status, body } and never throws for
// an HTTP error, so callers can explain a 404 in their own words.
export function githubApi({ auth = token(), base = "https://api.github.com" } = {}) {
  return async (path) => {
    const response = await fetch(`${base}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "plugin-marketplace-check-remotes",
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
}

const enc = (value) => value.split("/").map(encodeURIComponent).join("/");

// Checks one remote catalog entry. `api(path)` returns { status, body }.
export async function checkRemote(entry, api) {
  const { repo, sha, ref, path } = entry.source;
  const errors = [];
  const notes = [];
  const repository = await api(`/repos/${repo}`);
  if (repository.status !== 200) {
    errors.push(repository.status === 404
      ? `${repo} doesn't exist, or your token can't read it.`
      : `couldn't read ${repo} (HTTP ${repository.status}).`);
    return { name: entry.name, errors, notes };
  }
  const commit = await api(`/repos/${repo}/commits/${sha}`);
  if (commit.status !== 200 || commit.body?.sha?.toLowerCase() !== sha.toLowerCase()) {
    errors.push(`sha ${sha} isn't a commit in ${repo}.`);
    return { name: entry.name, errors, notes };
  }
  let manifest;
  const fetched = new Map();
  const load = async (candidate) => {
    if (fetched.has(candidate)) return fetched.get(candidate);
    const file = path ? `${path}/${candidate}` : candidate;
    const found = await api(`/repos/${repo}/contents/${enc(file)}?ref=${sha}`);
    let result;
    if (found.status === 200 && typeof found.body?.content === "string") {
      try { result = { file, candidate, data: JSON.parse(Buffer.from(found.body.content, "base64").toString("utf8")) }; }
      catch { result = { file, candidate, invalid: true }; }
    }
    fetched.set(candidate, result);
    return result;
  };
  // An Agent Plugins plugin.json at the root wins. Otherwise Copilot CLI reads
  // a legacy manifest from the first of its documented locations.
  const rootManifest = await load("plugin.json");
  if (rootManifest && isAgentPluginsManifest(rootManifest.data)) manifest = rootManifest;
  else {
    for (const candidate of legacyManifestPaths) {
      manifest = await load(candidate);
      if (manifest) break;
    }
  }
  if (manifest?.invalid) {
    errors.push(`${manifest.file} at the pinned sha isn't valid JSON.`);
    manifest = undefined;
  } else if (manifest && !isAgentPluginsManifest(manifest.data)) {
    notes.push(`upstream uses a legacy plugin manifest (${manifest.file}) rather than an Agent Plugins plugin.json. Copilot CLI loads legacy plugins, but confirm every host you support does.`);
  }
  if (!manifest && !errors.length) {
    errors.push(`no plugin.json under ${path ? `"${path}"` : "the repository root"} at the pinned sha. Check "path"; omit it when plugin.json is at the root.`);
  }
  if (manifest) {
    if (manifest.data?.name !== entry.name) {
      errors.push(`the upstream ${manifest.file} is named "${manifest.data?.name}", but the catalog entry is "${entry.name}". The catalog name must match.`);
    }
    if (entry.version !== undefined && manifest.data?.version !== undefined && manifest.data.version !== entry.version) {
      errors.push(`the catalog says version ${entry.version}, but ${manifest.file} at the pinned sha says ${manifest.data.version}.`);
    }
  }
  if (ref !== undefined) {
    const current = await api(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if (current.status !== 200) errors.push(`ref ${ref} doesn't exist in ${repo}.`);
    else if (current.body.sha.toLowerCase() !== sha.toLowerCase()) {
      const compare = await api(`/repos/${repo}/compare/${sha}...${current.body.sha}`);
      const status = compare.status === 200 ? compare.body?.status : undefined;
      const count = (number) => `${number} commit${number === 1 ? "" : "s"}`;
      if (status === "behind") {
        notes.push(`ref ${ref} is ${count(compare.body.behind_by)} behind the pinned sha. That's normal when upstream builds a release commit after tagging; confirm the sha matches upstream's own catalog.`);
      } else if (status === "ahead") {
        notes.push(`ref ${ref} is now ${count(compare.body.ahead_by)} ahead of the pinned sha. If you want those changes, review them and update sha${entry.version ? " and version" : ""}.`);
      } else if (status === "diverged") {
        notes.push(`ref ${ref} has diverged from the pinned sha: ${count(compare.body.ahead_by)} ahead and ${count(compare.body.behind_by)} behind. The pin may be on a side branch or a rewritten history; review before you update.`);
      } else {
        notes.push(`ref ${ref} now points at ${current.body.sha}, and GitHub couldn't compare it with the pinned sha. Check whether the tag or branch moved.`);
      }
    }
  }
  const latest = await api(`/repos/${repo}/releases/latest`);
  if (latest.status === 200 && latest.body?.tag_name && latest.body.tag_name !== ref) {
    notes.push(`the latest release in ${repo} is ${latest.body.tag_name}${ref ? `; the pin is ${ref}` : ""}. Releases can cover other packages in the same repository.`);
  }
  return { name: entry.name, errors, notes };
}

if (isEntrypoint(import.meta.url)) {
  await runCli(async () => {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: "boolean", short: "h" } } });
    if (values.help) return console.log(usage);
    const { remotePlugins } = await readCatalog(root);
    const selected = positionals.length ? remotePlugins.filter((entry) => positionals.includes(entry.name)) : remotePlugins;
    const missing = positionals.filter((name) => !remotePlugins.some((entry) => entry.name === name));
    if (missing.length) throw new Error(`No remote plugin named ${missing.join(", ")} in marketplace.json.`);
    if (!selected.length) return console.log("marketplace.json has no remote plugins to check.");
    const api = githubApi();
    const problems = [];
    for (const entry of selected) {
      const result = await checkRemote(entry, api);
      console.log(`${result.errors.length ? "✗" : "✓"} ${entry.name} (${entry.source.repo}${entry.source.path ? `/${entry.source.path}` : ""} at ${entry.source.sha.slice(0, 12)})`);
      for (const note of result.notes) console.log(`    Note: ${note}`);
      problems.push(...result.errors.map((error) => `${entry.name}: ${error}`));
    }
    if (problems.length) throw new Error(problems.join("\n"));
  });
}
