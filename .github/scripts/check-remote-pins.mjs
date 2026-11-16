import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agentPluginsSchema = /^https:\/\/agent-plugins\.org\/schemas\/\d+\.\d+\.\d+\/plugin\.schema\.json$/;
const supportedSchemas = new Set(["1.0.0", "1.1.0"].map((version) => `https://agent-plugins.org/schemas/${version}/plugin.schema.json`));
// Copilot CLI's plugin reference (github/docs@8e7396e); legacy order also tested in d838c30^.
const legacyManifestPaths = [".plugin/plugin.json", "plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json"];

export function githubApi(endpoint, run = spawnSync) {
  const result = run("gh", ["api", endpoint, "--include", "-H", "Accept: application/vnd.github.raw+json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`Couldn't run gh api (${result.error.code ?? "process error"}).`);
  const response = /^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout ?? "");
  if (!response) {
    throw new Error(`GitHub API request failed for ${endpoint} (exit ${result.status}; no HTTP response).`);
  }
  const status = Number(response[1]);
  if (result.status !== 0 && status === 200) {
    throw new Error(`gh api failed for ${endpoint} (exit ${result.status}) despite HTTP 200.`);
  }
  return { status, body: response[2] };
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} isn't valid JSON.`);
  }
}

function requireSuccess(response, label) {
  if (response.status !== 200) {
    throw new Error(`${label}: GitHub API returned HTTP ${response.status}${response.status === 404 ? " (not found, or your token can't read it)" : ""}.`);
  }
}

export function checkRemotePin(entry, api = githubApi) {
  const fail = (message) => { throw new Error(`${entry.name}: ${message}`); };
  const { source, repo, path, sha, ref } = entry.source ?? {};
  if (source !== "github") fail("only github remote sources are supported.");
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) fail("source.sha must be a full 40-character commit.");
  if (ref !== undefined && (typeof ref !== "string" || !ref.trim())) {
    fail("source.ref must be a non-empty string when supplied.");
  }

  const commit = api(`repos/${repo}/commits/${sha}`);
  requireSuccess(commit, `${entry.name}: commit ${sha} in ${repo}`);
  if (parseJson(commit.body, `${entry.name}: commit response`).sha !== sha) {
    fail(`GitHub didn't return the pinned commit ${sha}.`);
  }
  if (ref !== undefined) {
    const refCommit = api(`repos/${repo}/commits/${encodeURIComponent(ref)}`);
    requireSuccess(refCommit, `${entry.name}: ref ${ref} in ${repo}`);
    if (parseJson(refCommit.body, `${entry.name}: ref response`).sha !== sha) {
      fail(`source.ref ${ref} doesn't resolve to the pinned commit ${sha}.`);
    }
  }

  const fetched = new Map();
  const load = (candidate) => {
    if (fetched.has(candidate)) return fetched.get(candidate);
    const file = path ? `${path}/${candidate}` : candidate;
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    const response = api(`repos/${repo}/contents/${encoded}?ref=${sha}`);
    if (response.status === 404) {
      fetched.set(candidate, undefined);
      return undefined;
    }
    requireSuccess(response, `${entry.name}: ${repo}/${file}`);
    const manifest = { file, data: parseJson(response.body, `${entry.name}: ${file} at ${sha}`) };
    fetched.set(candidate, manifest);
    return manifest;
  };

  const root = load("plugin.json");
  let manifest;
  if (typeof root?.data?.$schema === "string" && agentPluginsSchema.test(root.data.$schema)) {
    if (!supportedSchemas.has(root.data.$schema)) fail(`root plugin.json declares an unsupported Agent Plugins schema: ${root.data.$schema}.`);
    manifest = root;
  } else {
    for (const candidate of legacyManifestPaths) {
      manifest = load(candidate);
      if (manifest) break;
    }
  }
  if (!manifest) fail(`no plugin.json under ${path || "the repository root"} at ${sha}.`);
  if (manifest.data?.name !== entry.name) {
    fail(`upstream ${manifest.file} is named ${manifest.data?.name}, expected ${entry.name}.`);
  }
  if (entry.version !== undefined && manifest.data.version !== undefined && manifest.data.version !== entry.version) {
    fail(`upstream ${manifest.file} has version ${manifest.data.version}, expected ${entry.version}.`);
  }
  return manifest.file;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  const entries = JSON.parse(readFileSync("marketplace.json", "utf8")).plugins
    .filter((entry) => typeof entry.source === "object");
  for (const entry of entries) {
    const file = checkRemotePin(entry);
    console.log(`${entry.name}: ${entry.source.repo}@${entry.source.sha} (${file}) ok`);
  }
  if (!entries.length) console.log("No remote pins to check.");
}
