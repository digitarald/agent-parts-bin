import test from "node:test";
import assert from "node:assert/strict";
import { resolve, delimiter, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { checkCoverage, discoverAssets, readEvals, root, suiteTags } from "../scripts/validate-evals.mjs";
import { evalFilenameMatcher, parseTagSelectors, readCatalog, readVallyConfig } from "../scripts/catalog.mjs";
import { defaultRuntime, pluginDirectories, runtimeArguments, runtimeEntry } from "../scripts/eval-runtime.js";
import { evalParams, isPathParam, pathParams, reportArguments, runtimeBridge, runtimeEnvironment, vallyArguments, vallyCliPath, vallySelection } from "../scripts/evals.mjs";
import { expectedCases, render, summarize } from "../scripts/eval-report.mjs";

test("all local assets have positive, smoke, and negative coverage", async () => {
  const config = await readVallyConfig(root);
  const assets = await discoverAssets();
  const specs = await readEvals(root, config);
  const { localPlugins } = await readCatalog(root);
  // A marketplace with no local plugins (only remote entries, or none yet) has nothing to cover.
  if (!assets.length) return assert.equal(checkCoverage(assets, specs, { suites: suiteTags(config) }), specs.flatMap(({ spec }) => spec.stimuli).length);
  for (const asset of assets) assert.ok(localPlugins.some((plugin) => asset.id.split(":")[1].startsWith(`${plugin.name}/`)));
  const stimuli = specs.flatMap(({ spec }) => spec.stimuli);
  assert.equal(checkCoverage(assets, specs, { suites: suiteTags(config) }), stimuli.length);
  for (const asset of assets) {
    const withoutPositive = specs.map((item) => ({ ...item, spec: { ...item.spec,
      stimuli: item.spec.stimuli.filter((stimulus) => !(stimulus.tags.control === "positive" && [stimulus.tags.assets].flat().includes(asset.id))) } }))
      .filter((item) => item.spec.stimuli.length);
    assert.throws(() => checkCoverage(assets, withoutPositive, { suites: suiteTags(config) }), /missing/);
  }
});

test("the brainstorm example keeps explicit headless canvas boundaries", { skip: !existsSync(resolve(root, "plugins/team-brainstorm")) }, async () => {
  const assets = await discoverAssets();
  const specs = await readEvals();
  const canvasCases = specs.flatMap(({ spec }) => spec.stimuli).filter((stimulus) => stimulus.agent_environment?.mcpServers?.["brainstorm-host"]);
  assert.ok(canvasCases.length >= 2);
  for (const stimulus of canvasCases) assert.equal(stimulus.tags.boundary, "headless-sdk-contract");
  const ungradedNegative = structuredClone(specs);
  const arithmetic = ungradedNegative.flatMap(({ spec }) => spec.stimuli).find((stimulus) => stimulus.name === "brainstorm-does-not-trigger-for-arithmetic");
  arithmetic.tags.assets = ["skill:team-brainstorm/team-brainstorm"];
  assert.throws(() => checkCoverage(assets, ungradedNegative), /extension:team-brainstorm\/brainstorm: missing negative control/);
  const relabeled = structuredClone(specs);
  relabeled.flatMap(({ spec }) => spec.stimuli).find((stimulus) => stimulus.name === "brainstorm-preserves-and-moves-session-notes").tags.boundary = "native-ui";
  assert.throws(() => checkCoverage(assets, relabeled), /host boundary honestly/);
});

test("the bug-report example must load its actual skill", { skip: !existsSync(resolve(root, "plugins/bug-report")) }, async () => {
  const assets = await discoverAssets();
  const specs = await readEvals();
  const unloaded = structuredClone(specs);
  unloaded.find((item) => item.spec.name === "bug-report-behavior").spec.agent_environment.skills = [];
  assert.throws(() => checkCoverage(assets, unloaded), /load the actual skill/);
});

test("eval-only dependencies stay out of plugins and remote installation stays opt-in", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const [name, version] of Object.entries({
    "@github/copilot": "1.0.98", "@microsoft/vally-cli": "0.19.0", "@modelcontextprotocol/sdk": "1.32.1",
  })) assert.equal(manifest.devDependencies[name], version);
  for (const version of Object.values(manifest.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.engines.node, ">=22.14.0");
  const settings = JSON.parse(await readFile(resolve(root, ".github/copilot/settings.json"), "utf8"));
  const { catalog, localPlugins, remotePlugins } = await readCatalog(root);
  assert.deepEqual(Object.keys(settings.enabledPlugins).sort(), localPlugins.map((entry) => `${entry.name}@${catalog.name}`).sort());
  for (const remote of remotePlugins) assert.equal(settings.enabledPlugins[`${remote.name}@${catalog.name}`], undefined);
});

test("runtime setup uses the pinned full runtime bridge and mounts only requested plugin directories", () => {
  const env = runtimeEnvironment({ Path: "/existing", STARTER_PLUGIN_DIRS: "plugins/format-json" });
  assert.equal(Object.keys(env).filter((name) => name.toLowerCase() === "path").length, 1);
  assert.equal(env.PATH.split(delimiter)[0], resolve(root, "node_modules/.bin"));
  assert.equal(env.COPILOT_CLI_PATH, runtimeBridge);
  assert.equal(env.MARKETPLACE_VALLY_CLI, undefined);
  assert.equal(runtimeEntry({}), resolve(root, "node_modules/@github/copilot/npm-loader.js"));
  assert.equal(runtimeEntry({}), defaultRuntime);
  const args = runtimeArguments(["--headless", "--stdio"], env);
  assert.ok(args.includes("--no-ask-user"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.equal(args[args.indexOf("--plugin-dir") + 1], resolve(root, "plugins/format-json"));
  assert.ok(!runtimeArguments([], {}).includes("--plugin-dir"));
  const absolute = resolve(root, "plugins/other");
  assert.deepEqual(pluginDirectories({ STARTER_PLUGIN_DIRS: ` plugins/a , ${absolute},,` }), [resolve(root, "plugins/a"), absolute]);
  assert.equal(runtimeArguments([], { STARTER_PLUGIN_DIRS: "plugins/a,plugins/b" }).filter((arg) => arg === "--plugin-dir").length, 2);
  assert.throws(() => runtimeEntry({ STARTER_COPILOT_CLI: "npm-loader.js" }), /absolute/);
});

test("the launcher passes absolute values for every .vally.yaml path param and keeps bounded retries", async () => {
  const config = parse(await readFile(resolve(root, ".vally.yaml"), "utf8"));
  assert.ok(config.suites.smoke?.filter?.suite === "smoke", "CI runs the smoke suite by default.");
  const configuredPaths = Object.entries(config.params ?? {}).filter(([, value]) => isPathParam(value));
  assert.deepEqual(Object.keys(evalParams).sort(), configuredPaths.map(([name]) => name).sort());
  for (const [name, value] of configuredPaths) {
    assert.ok(isAbsolute(evalParams[name]));
    assert.equal(evalParams[name], resolve(root, value));
  }
  assert.ok(!isPathParam("gpt-5.4-mini") && !isPathParam(["a/b"]) && !isPathParam("https://example.com/a") && isPathParam("evals/x.mjs"));
  const run = vallyArguments("eval", ["--suite", "smoke"]);
  for (const flag of [["--workers", "1"], ["--max-retries", "1"], ["--output-dir", "vally-results"]]) {
    assert.equal(run[run.indexOf(flag[0]) + 1], flag[1]);
  }
  assert.ok(run.includes("--junit"));
  assert.ok(!run.includes("--require-pass"));
  for (const [name, value] of Object.entries(evalParams)) assert.ok(run.includes(`${name}=${value}`));
  assert.deepEqual(vallyArguments("lint").slice(1, 6), ["lint", "plugins", "--eval-spec", "evals", "--strict"]);
  assert.throws(() => vallyArguments("plan"), /Use eval/);
});

test("path params come only from .vally.yaml, so removing an example removes its param", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-params-"));
  try {
    assert.deepEqual(await pathParams(directory), {});
    await writeFile(join(directory, ".vally.yaml"), "params:\n  SERVER: tools/server.mjs\n  MODEL: gpt-5.4-mini\n");
    assert.deepEqual(await pathParams(directory), { SERVER: resolve(directory, "tools/server.mjs") });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("eval discovery follows .vally.yaml evalFilenames, including a custom *.eval.yaml pattern", async () => {
  const directory = await mkdtemp(join(tmpdir(), "starter-eval-names-"));
  try {
    await mkdir(join(directory, "evals/a"), { recursive: true });
    await mkdir(join(directory, "evals/graders/dist"), { recursive: true });
    await writeFile(join(directory, "evals/a/eval.yaml"), "name: a\nstimuli: []\n");
    await writeFile(join(directory, "evals/a/release.eval.yaml"), "name: b\nstimuli: []\n");
    await writeFile(join(directory, "evals/a/eval.params.yaml"), "params: {}\n");
    await writeFile(join(directory, "evals/graders/dist/ignored.eval.yaml"), "name: dist\n");
    const names = async (config) => (await readEvals(directory, config)).map(({ spec }) => spec.name).sort();
    assert.deepEqual(await names({ paths: { evalFilenames: ["eval.yaml", "*.eval.yaml"] } }), ["a", "b"]);
    assert.deepEqual(await names({ paths: { evalFilenames: ["*.eval.yaml"] } }), ["b"]);
    assert.deepEqual(await names({}), ["a"]);
    assert.deepEqual(await readEvals(directory, { paths: { evalFilenames: ["missing.yaml"] } }), []);
    assert.throws(() => evalFilenameMatcher(["evals/**/eval.yaml"]), /plain file names/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const trial = (passed = true) => ({
  type: "trial-result", runId: "one", stimulus: "case", status: "success",
  gradeResult: { passed, score: passed ? 1 : 0, details: [] },
  trajectory: { events: [] },
});
const footer = { type: "run-summary", runId: "one", hadExecutionErrors: false };
const expected = new Set(["case"]);

test("reporting keeps valid failures visible and rejects incomplete or malformed results", () => {
  const failed = summarize([trial(false), footer], expected);
  assert.equal(failed.errors.length, 0);
  assert.match(render(failed, "saved-run"), /BEHAVIORAL FAILURE/);
  assert.match(render(summarize([trial(), footer], expected), "run-123"), /run-123[\s\S]*PASS/);
  assert.throws(() => summarize([], expected), /completion/);
  assert.throws(() => summarize([trial()], expected), /completion/);
  assert.throws(() => summarize([{ ...trial(), runId: "other" }, footer], expected), /mixed/);
  assert.throws(() => summarize([footer], expected), /No cases/);
  assert.throws(() => summarize([{ ...trial(), stimulus: "not-in-suite" }, footer], expected), /Unexpected/);
  assert.throws(() => summarize([{ ...trial(), type: "unrecognized" }, footer], expected), /Unexpected/);
  assert.throws(() => summarize([{ ...trial(), status: "unknown" }, footer], expected), /Unknown trial status/);
  assert.throws(() => summarize([{ ...trial(), gradeResult: { passed: "false", score: 1 } }, footer], expected), /Invalid grade/);
  assert.equal(summarize([trial(), { ...footer, hadExecutionErrors: true }], expected).errors.length, 1);
  assert.equal(summarize([trial(), footer], new Set(["case", "missing"])).errors.length, 1);
});

test("runtime and grader infrastructure errors never become report-only scores", () => {
  for (const record of [
    { ...trial(), status: "error", error: "Timed out" },
    { ...trial(), status: "skipped", skipReason: "Unsupported" },
    { ...trial(), gradeResult: { passed: false, score: 0, status: "error" } },
    { ...trial(), gradeResult: { passed: false, score: 0, details: [{ status: "error", evidence: "invalid grader" }] } },
    { ...trial(), gradeResult: null },
    { ...trial(), trajectory: { events: [{ type: "error", data: { message: "MCP failed to initialize" } }] } },
  ]) {
    const result = summarize([record, footer], expected);
    assert.equal(result.errors.length, 1);
    assert.equal(result.rows[0].score, undefined);
    assert.match(result.rows[0].status, /ERROR/);
  }
  const mcp = summarize([{ ...trial(false), trajectory: { events: [{ type: "error", data: { message: "Server file not found" } }] } }, footer], expected);
  assert.match(mcp.errors[0], /Server file not found/);
});

test("the source validator accepts CRLF changelog headings and excludes generated eval reports", async () => {
  const script = await readFile(resolve(root, "scripts/validate.mjs"), "utf8");
  assert.ok(script.includes('replaceAll("\\r\\n", "\\n")'));
  assert.ok(script.includes('"vally-results"'));
});


// These check the safety properties of the workflows, not their exact shape, so
// the customizations docs/ci.md describes keep npm run verify passing: trimming
// the validate matrix, removing the evals environment, uploading transcripts
// for a debug run, or deleting evals.yml.
test("deterministic CI stays model-free, and opt-in behavioral CI runs the pinned Vally launcher on trusted code", async () => {
  const automatic = parse(await readFile(resolve(root, ".github/workflows/validate.yml"), "utf8"));
  const evalsPath = resolve(root, ".github/workflows/evals.yml");
  const evals = existsSync(evalsPath) ? parse(await readFile(evalsPath, "utf8")) : undefined;
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.deepEqual(automatic.permissions, { contents: "read" });
  // Pull requests, plus pushes to named branches only, so a pushed PR branch
  // doesn't run every job twice; a newer push cancels the superseded run.
  assert.ok("pull_request" in automatic.on, "validate.yml should run on pull requests.");
  assert.ok(!("pull_request_target" in automatic.on));
  if (automatic.on.push !== undefined) assert.ok(automatic.on.push?.branches?.length, "Limit validate.yml's push trigger to your default branch.");
  assert.match(String(automatic.concurrency?.group ?? ""), /github\.ref/);
  assert.ok(automatic.concurrency?.["cancel-in-progress"], "Cancel superseded validate runs.");
  const { matrix } = automatic.jobs.validate.strategy;
  assert.ok(Array.isArray(matrix.os) && matrix.os.length, "Keep at least one operating system in the matrix.");
  assert.ok(Array.isArray(matrix.node) && matrix.node.length && matrix.node.every((major) => Number(major) >= 22), "Test Node.js 22 or newer.");
  assert.ok(automatic.jobs.validate.steps.some((step) => step.run === "npm run verify"));
  for (const workflow of [automatic, evals].filter(Boolean)) {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        assert.equal(step["continue-on-error"], undefined);
        if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${step.uses}: pin every action to a full commit SHA.`);
        if (step.uses?.startsWith("actions/checkout")) assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
  assert.ok(manifest.scripts.verify.includes("eval:lint"));
  assert.ok(manifest.scripts.verify.includes("build:check"));
  assert.ok(!manifest.scripts.verify.includes("eval:smoke"));
  assert.ok(!manifest.scripts.verify.includes("npm run eval "));
  if (!evals) return;

  assert.ok(!("pull_request_target" in evals.on));
  assert.deepEqual(evals.permissions, { contents: "read" });
  const runners = Object.entries(evals.jobs).filter(([, job]) => job.steps.some((step) => /scripts\/evals\.mjs eval\b/.test(step.run ?? "")));
  assert.ok(runners.length, "evals.yml should have a job that runs evals.");
  for (const [name, job] of runners) {
    // An environment is optional (docs/ci.md explains when to drop it); if
    // there is one, it's the evals environment.
    if (job.environment !== undefined) assert.equal(job.environment?.name ?? job.environment, "evals", name);
    assert.equal(String(job.env?.VALLY_TELEMETRY_OPTOUT), "1", name);
    // Opt-in, never on forks or drafts.
    assert.match(job.if, /github\.event_name == 'workflow_dispatch' \|\|/, name);
    assert.match(job.if, /vars\.ENABLE_EVALS == 'true' &&/, name);
    assert.match(job.if, /head\.repo\.full_name == github\.repository/, name);
    assert.match(job.if, /!github\.event\.pull_request\.draft/, name);
    // A paid run is never cancelled halfway by a newer push.
    assert.equal(job.concurrency?.["cancel-in-progress"], false, name);
    assert.ok(!Object.values(job.permissions ?? {}).includes("write-all") && job.permissions?.contents === "read", name);
    const setupNode = job.steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    assert.ok(Number(setupNode.with["node-version"]) >= 22, name);
    const preflight = job.steps.find((step) => step.name === "Check the runtime bridge");
    if (preflight) assert.ok(job.steps.indexOf(job.steps.find((step) => step.run?.startsWith("npm ci"))) < job.steps.indexOf(preflight), name);
  }
  for (const [name, job] of runners) {
    const runStep = job.steps.find((step) => /scripts\/evals\.mjs eval\b/.test(step.run ?? ""));
    assert.ok(runStep.run.includes("--require-pass"), name);
    const report = job.steps.find((step) => /eval-report\.mjs/.test(step.run ?? ""));
    if (report) assert.ok(job.steps.indexOf(runStep) < job.steps.indexOf(report), name);
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    if (upload) assert.match(upload.if, /vars\.EVALS_UPLOAD_RESULTS == 'true'/, "Transcripts upload only when someone opts in.");
  }
});

test("reports select the cases of a configured suite or of specific eval specs", () => {
  const specs = [
    { path: resolve(root, "evals/a/eval.yaml"), spec: { stimuli: [{ name: "a-smoke", tags: { suite: "smoke" } }, { name: "a-other", tags: {} }] } },
    { path: resolve(root, "evals/b/release.eval.yaml"), spec: { stimuli: [{ name: "b-ci", tags: { lane: ["ci", "nightly"] } }] } },
  ];
  const config = { suites: {
    smoke: { filter: { suite: "smoke" } },
    ci: { filter: { lane: "ci" } },
    full: { evals: ["evals/**/eval.yaml", "evals/**/*.eval.yaml"] },
    "a-only": { evals: ["evals/a/*.yaml"] },
  } };
  const names = (options) => [...expectedCases(specs, config, options)].sort();
  assert.deepEqual(names({}), ["a-other", "a-smoke", "b-ci"]);
  assert.deepEqual(names({ suite: "smoke" }), ["a-smoke"]);
  assert.deepEqual(names({ suite: "ci" }), ["b-ci"]);
  assert.deepEqual(names({ suite: "a-only" }), ["a-other", "a-smoke"]);
  assert.deepEqual(names({ evalSpecs: ["evals/b/release.eval.yaml"] }), ["b-ci"]);
  assert.deepEqual(names({ evalSpecs: ["evals/a/eval.yaml"], suite: "smoke" }), ["a-smoke"]);
  assert.throws(() => expectedCases(specs, config, { suite: "nightly" }), /Unknown suite nightly/);
  assert.throws(() => expectedCases(specs, config, { evalSpecs: ["evals/missing/eval.yaml"] }), /No eval spec/);
  assert.throws(() => expectedCases(specs, config, { evalSpecs: ["evals/b/release.eval.yaml"], suite: "smoke" }), /no cases/);
});

test("selection follows Vally: eval-level tags are inherited, a case's own tag wins, and --tag includes or excludes", () => {
  const specs = [
    { path: resolve(root, "evals/ci/eval.yaml"), spec: { tags: { lane: "ci", control: "positive" }, stimuli: [
      { name: "inherits-ci", tags: {} },
      { name: "overrides-lane", tags: { lane: "nightly" } },
      { name: "negative-ci", tags: { control: "negative" } },
    ] } },
    { path: resolve(root, "evals/other/eval.yaml"), spec: { stimuli: [{ name: "untagged" }, { name: "smoke-one", tags: { suite: "smoke", control: "negative" } }] } },
  ];
  const config = { suites: { ci: { filter: { lane: "ci" } }, smoke: { filter: { suite: "smoke" } }, full: { evals: ["evals/**/eval.yaml"] } } };
  const names = (options) => [...expectedCases(specs, config, options)].sort();
  assert.deepEqual(names({ suite: "ci" }), ["inherits-ci", "negative-ci"]);
  assert.deepEqual(names({ tags: ["control=negative"] }), ["negative-ci", "smoke-one"]);
  // A missing key never matches an exclusion, as in Vally.
  assert.deepEqual(names({ tags: ["control!=negative"] }), ["inherits-ci", "overrides-lane", "untagged"]);
  assert.deepEqual(names({ tags: ["lane=ci,nightly", "control=positive"] }), ["inherits-ci", "overrides-lane"]);
  assert.deepEqual(names({ suite: "full", tags: ["control=negative"] }), ["negative-ci", "smoke-one"]);
  assert.deepEqual(names({ evalSpecs: ["evals/ci/eval.yaml"], tags: ["control!=negative"] }), ["inherits-ci", "overrides-lane"]);
  assert.throws(() => parseTagSelectors(["nokey"]), /Invalid --tag/);
  assert.deepEqual(parseTagSelectors(["a=1,2", "a=3", "b!=x"]), { include: { a: ["1", "2", "3"] }, exclude: { b: ["x"] } });
  // Coverage sees the same inherited tags.
  const asset = { id: "skill:p/p", kind: "skill", name: "p", path: resolve(root, "plugins/p/skills/p") };
  const inherited = [{ path: resolve(root, "evals/p/eval.yaml"), spec: { tags: { assets: asset.id }, agent_environment: { skills: ["../../plugins/p/skills/p"] }, stimuli: [
    { name: "p-runs", tags: { control: "positive", suite: "smoke" }, graders: [{ type: "skill-invocation", config: { required: ["p"] } }, { type: "output-contains", config: { substring: "p" } }] },
    { name: "p-skips", tags: { control: "negative" }, graders: [{ type: "skill-invocation", config: { disallowed: ["p"] } }] },
  ] } }];
  assert.equal(checkCoverage([asset], inherited), 2);
});

test("tag selection matches Vally's own filter on this repository's evals", async (t) => {
  let vally;
  try { vally = await import("@microsoft/vally"); } catch { return t.skip("@microsoft/vally isn't installed where the test can import it"); }
  const config = await readVallyConfig(root);
  const specs = await readEvals(root, config);
  if (!specs.length) return t.skip("no eval specs");
  for (const tags of [["control=negative"], ["control!=negative"], ["suite=smoke"], ["suite=smoke", "control=positive"]]) {
    const theirs = specs.flatMap(({ spec }) => vally.filterStimuli(spec.stimuli, spec.tags, vally.parseSuiteFilter(tags)).matched.map((stimulus) => stimulus.name)).sort();
    let ours = [];
    try { ours = [...expectedCases(specs, config, { tags })].sort(); } catch (error) { if (!/no cases/.test(error.message)) throw error; }
    assert.deepEqual(ours, theirs, tags.join(" "));
  }
});

test("the launcher turns a suite with --plugin, --eval-spec, or --tag into a selection Vally accepts", () => {
  const config = { suites: { smoke: { filter: { suite: "smoke" } }, full: { evals: ["evals/**/eval.yaml"] } } };
  const specPaths = ["evals/a/eval.yaml", "evals/a/agent/eval.yaml", "evals/b/other.yaml"];
  assert.deepEqual(vallySelection([], config), ["--suite", "full"]);
  assert.deepEqual(vallySelection(["--model", "x"], config), ["--suite", "full", "--model", "x"]);
  assert.throws(() => vallySelection([], { suites: {} }), /Choose what to run/);
  assert.deepEqual(vallySelection(["--suite", "smoke"], config), ["--suite", "smoke"]);
  assert.deepEqual(vallySelection(["--eval-spec", "evals/a/eval.yaml", "--suite", "smoke", "--require-pass"], config),
    ["--eval-spec", "evals/a/eval.yaml", "--tag", "suite=smoke", "--require-pass"]);
  assert.deepEqual(vallySelection(["--suite", "full", "--eval-spec", "evals/a/eval.yaml"], config), ["--eval-spec", "evals/a/eval.yaml"]);
  assert.deepEqual(vallySelection(["--suite", "full", "--tag", "control=negative"], config, { specPaths }),
    ["--eval-spec", "evals/a/eval.yaml", "--eval-spec", "evals/a/agent/eval.yaml", "--tag", "control=negative"]);
  assert.deepEqual(vallySelection(["--suite=smoke", "--tag=control!=negative"], config), ["--tag", "suite=smoke", "--tag", "control!=negative"]);
  assert.throws(() => vallySelection(["--suite", "smoke", "--tag", "suite=full"], config), /already filters on suite/);
  assert.throws(() => vallySelection(["--suite", "full", "--eval-spec", "evals/b/other.yaml"], config), /None of the selected eval specs are in the full suite/);
  // The report gets only options it understands, never Vally's run options.
  assert.deepEqual(reportArguments(["--suite", "smoke", "--model", "gpt-5.4", "--require-pass", "-e", "evals/a/eval.yaml", "--tag", "x=y"], ["a"]),
    ["--suite", "smoke", "--plugin", "a", "--eval-spec", "evals/a/eval.yaml", "--tag", "x=y"]);
});

// The template locks every package to registry.npmjs.org. A team that installs
// through its own mirror can change the hosts, but keeps HTTPS and sha512.
test("every locked package resolves over HTTPS with a sha512 integrity hash", async () => {
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path || entry.link) continue;
    assert.match(entry.resolved ?? "", /^https:\/\//, `${path}: resolve over HTTPS.`);
    assert.match(entry.integrity ?? "", /^sha512-/, `${path}: use a sha512 integrity hash, not sha1.`);
  }
});
