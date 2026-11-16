import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checksFingerprint, projectResults, renderComparison, selectSkillFiles, validatePullRequest } from "./commit-attribution-pr.mjs";
import { compareSummaries, summarizeRun } from "./eval-report.mjs";

const expected = { name: "synthetic-eval", cases: ["draft", "routing"], checks: ["completed"], hash: "eval-hash" };
const model = "pinned-model";
const identity = {
  repository: "owner/repo", pr: 7, base: "a".repeat(40), head: "b".repeat(40), harness: "c".repeat(40), checksChanged: false,
};
const pull = () => ({
  number: 7, state: "open",
  base: { sha: identity.base, ref: "main", repo: { full_name: identity.repository } },
  head: { sha: identity.head, repo: { full_name: "contributor/fork" } },
});
const records = (passed = true) => [
  ...expected.cases.map((stimulus) => ({
    type: "trial-result", runId: "synthetic-run", evalName: expected.name, stimulus, status: "success",
    durationMs: 2000, gradeResult: { passed, score: passed ? 1 : 0, details: [] },
    trajectory: {
      metadata: { model }, output: "SYNTHETIC_PRIVATE_TEXT", events: [],
      metrics: { tokenUsage: { inputTokens: 90, outputTokens: 10, totalTokens: 100 } },
    },
  })),
  { type: "run-summary", runId: "synthetic-run", hadExecutionErrors: false },
];
const bundle = () => ({
  version: 1, ...identity, model, evalHash: expected.hash,
  baseline: { records: records(false), exitCode: 1 }, candidate: { records: records(), exitCode: 0 },
});
const render = (value, approved = identity) => renderComparison(value, expected, model, approved, "https://github.com/owner/repo/actions/runs/1");

test("PR approval is tied to an open main-targeting PR and its exact head, including forks", () => {
  assert.equal(validatePullRequest(pull(), identity.repository, 7, identity.head).headRepository, "contributor/fork");
  for (const mutate of [
    (pr) => { pr.head.sha = "d".repeat(40); },
    (pr) => { pr.base.ref = "other-branch"; },
    (pr) => { pr.state = "closed"; },
    (pr) => { pr.base.repo.full_name = "other/repo"; },
    (pr) => { pr.head.repo = null; },
  ]) {
    const pr = pull();
    mutate(pr);
    assert.throws(() => validatePullRequest(pr, identity.repository, 7, identity.head));
  }
  assert.throws(() => validatePullRequest(pull(), identity.repository, "7/../../other", identity.head));
  assert.throws(() => validatePullRequest(pull(), identity.repository, 7, "main"));
});

test("skill capture rejects truncated trees, symlinks, traversal, missing skills, and oversized input", () => {
  const file = { path: "plugins/commit-attribution/skills/commit/SKILL.md", sha: "a".repeat(40), mode: "100644", type: "blob", size: 12 };
  assert.deepEqual(selectSkillFiles({ tree: [file, { path: "package.json", type: "blob" }] }), [file]);
  for (const tree of [
    { tree: [file], truncated: true },
    { tree: [] },
    { tree: [{ ...file, mode: "120000" }] },
    { tree: [file, { ...file, path: "plugins/commit-attribution/skills/commit/../outside" }] },
    { tree: [{ ...file, size: 3 * 1024 * 1024 }] },
  ]) assert.throws(() => selectSkillFiles(tree));
});

test("check-change detection distinguishes subject edits from changed graders and runner settings", () => {
  const tree = { tree: [
    { path: "evals/commit-attribution/skills/commit/commit.eval.yaml", sha: "one", mode: "100644" },
    { path: "plugins/commit-attribution/skills/commit/SKILL.md", sha: "one", mode: "100644" },
    { path: "package-lock.json", sha: "one", mode: "100644" },
  ] };
  const subjectChange = structuredClone(tree);
  subjectChange.tree[1].sha = "two";
  assert.equal(checksFingerprint(tree), checksFingerprint(subjectChange));
  for (const index of [0, 2]) {
    const checksChange = structuredClone(tree);
    checksChange.tree[index].sha = "two";
    assert.notEqual(checksFingerprint(tree), checksFingerprint(checksChange));
  }
});

test("report artifacts retain outcomes and metrics, not prompts, tool arguments, or raw grader evidence", () => {
  const raw = records(false);
  raw[0].gradeResult.details = [{ name: "SYNTHETIC_PRIVATE_TEXT", passed: false, reason: "SYNTHETIC_PRIVATE_TEXT" }];
  raw[0].trajectory.events = [{ type: "tool_call", data: { arguments: "SYNTHETIC_PRIVATE_TEXT" } }];
  const reduced = projectResults(raw, expected, model);
  const summary = summarizeRun(reduced);
  assert.equal(summary.failedCount, 2);
  assert.equal(summary.tokenUsage.totalTokens, 200);
  assert.equal(summary.totalDurationMs, 4000);
  assert.doesNotMatch(JSON.stringify(reduced), /SYNTHETIC_PRIVATE_TEXT/);
  assert.deepEqual(projectResults(reduced, expected, model), reduced);
});

test("comparison rejects missing or duplicated cases, changed models, and mismatched provenance", () => {
  for (const mutate of [
    (rows) => { rows.pop(); },
    (rows) => { rows.splice(0, 1); },
    (rows) => { rows[1].stimulus = rows[0].stimulus; },
    (rows) => { rows[0].trajectory.metadata.model = "other-model"; },
    (rows) => { delete rows[0].trajectory.metadata.model; },
    (rows) => { rows[0].evalName = "other-eval"; },
  ]) {
    const rows = records();
    mutate(rows);
    assert.throws(() => projectResults(rows, expected, model));
  }
  for (const key of ["head", "base", "harness", "evalHash", "model", "checksChanged"]) {
    const value = bundle();
    value[key] = "changed";
    assert.throws(() => render(value));
  }
});

test("PR tables show behavioral changes and changed-check warnings, but never call infrastructure errors fixes", () => {
  const value = bundle();
  const result = render(value);
  assert.match(result.markdown, /Baseline vs\. Candidate Comparison/);
  assert.match(result.markdown, /Fixed/);
  assert.equal(result.failed, true);
  const clean = bundle();
  clean.baseline = clean.candidate;
  assert.equal(render(clean).failed, false);
  value.checksChanged = true;
  assert.match(render(value, { ...identity, checksChanged: true }).markdown, /Checks or execution settings differ/);

  const infrastructure = bundle();
  infrastructure.baseline.records[0].gradeResult.status = "error";
  const errorReport = render(infrastructure);
  assert.match(errorReport.markdown, /draft \| ERROR \/ NOT EVALUATED .*Not comparable/);
  assert.equal(errorReport.failed, true);
  const deltas = compareSummaries(summarizeRun(infrastructure.baseline.records), summarizeRun(infrastructure.candidate.records)).deltas;
  assert.equal(deltas.averageScore, undefined);
  assert.equal(deltas.totalTokens, undefined);

  infrastructure.candidate = { exitCode: 1, problem: "results-unavailable" };
  const incomplete = render(infrastructure);
  assert.match(incomplete.markdown, /candidate: execution or result-processing error/);
  assert.doesNotMatch(incomplete.markdown, /Baseline vs\. Candidate Comparison/);
  assert.equal(incomplete.failed, true);
});

test("comparison CLI runs both snapshots after a behavioral failure and publishes only current-head metrics using fake services", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "attribution-pr-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "trusted");
  const prepared = join(directory, "prepared");
  const evalFile = "evals/commit-attribution/skills/commit/commit.eval.yaml";
  const content = JSON.stringify({
    name: expected.name, defaults: { runs: 1, executor: "copilot-sdk" }, tags: { suite: "smoke" },
    stimuli: expected.cases.map((name) => ({ name, graders: [{ type: "completed" }] })),
  });
  const fixture = (path, text, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, { mode });
  };
  for (const snapshot of [root, join(prepared, "baseline"), join(prepared, "candidate")]) {
    fixture(join(snapshot, evalFile), content);
  }
  fixture(join(prepared, "plan.json"), JSON.stringify({
    version: 1, ...identity, model, evalHash: createHash("sha256").update(content).digest("hex"),
  }));
  fixture(join(root, "node_modules/@microsoft/vally-cli/dist/index.js"), `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const args = process.argv.slice(2);
    const option = (name) => args[args.indexOf(name) + 1];
    assert.equal(args[0], "eval");
    assert.equal(option("--model"), ${JSON.stringify(model)});
    assert.equal(option("--max-retries"), "0");
    assert.equal(option("--workers"), "1");
    assert.equal(option("--timeout"), "2m");
    assert.ok(args.includes("--require-pass"));
    assert.equal(fs.readFileSync(option("--eval-spec"), "utf8"), ${JSON.stringify(content)});
    assert.equal(process.env.GITHUB_OUTPUT, undefined);
    assert.equal(process.env.GH_TOKEN, undefined);
    assert.equal(process.env.ACTIONS_RUNTIME_TOKEN, undefined);
    assert.equal(process.env.GITHUB_TOKEN, "synthetic-read-token");
    const baseline = path.basename(process.cwd()) === "baseline";
    const rows = ${JSON.stringify(records())};
    for (const row of rows.filter((entry) => entry.type === "trial-result")) {
      row.gradeResult = { passed: !baseline, score: baseline ? 0 : 1, details: [] };
    }
    const target = path.join(option("--output-dir"), "synthetic-run");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "results.jsonl"), rows.map(JSON.stringify).join("\\n"));
    process.exitCode = baseline ? 1 : 0;
  `);
  const posted = join(directory, "posted.json");
  const bin = join(directory, "bin");
  fixture(join(bin, "gh"), `#!/usr/bin/env node
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    if (args.includes("--method")) {
      fs.writeFileSync(${JSON.stringify(posted)}, fs.readFileSync(0));
      console.log("{}");
    } else if (args[1].endsWith("/comments")) {
      console.log("[[]]");
    } else if (args[1] === "repos/owner/repo/pulls/7") {
      console.log(${JSON.stringify(JSON.stringify(pull()))});
    } else {
      throw new Error("Unexpected fake API call");
    }
  `, 0o755);
  const output = join(directory, "outputs");
  const summary = join(directory, "summary");
  const env = {
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
    HOME: directory, RUNNER_TEMP: directory, COMPARISON_DIR: prepared, REPORT_DIR: directory,
    EVAL_MODEL: model, GITHUB_REPOSITORY: identity.repository, GITHUB_SHA: identity.harness, GITHUB_RUN_ID: "1",
    GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_TOKEN: "synthetic-read-token",
    GH_TOKEN: "synthetic-publish-token", ACTIONS_RUNTIME_TOKEN: "synthetic-artifact-token",
    PR_NUMBER: "7", EXPECTED_HEAD: identity.head, EXPECTED_BASE: identity.base, CHECKS_CHANGED: "false",
  };
  const script = fileURLToPath(new URL("./commit-attribution-pr.mjs", import.meta.url));
  const invoke = (command) => spawnSync(process.execPath, [script, command], { cwd: root, env, encoding: "utf8", timeout: 10000 });
  const execution = invoke("run");
  assert.ifError(execution.error);
  assert.equal(execution.status, 1, execution.stderr);
  assert.equal(execution.stderr, "");
  const saved = readFileSync(join(directory, "pr-eval-report.json"), "utf8");
  const result = JSON.parse(saved);
  assert.equal(result.baseline.exitCode, 1);
  assert.equal(result.candidate.exitCode, 0);
  assert.doesNotMatch(saved, /SYNTHETIC_PRIVATE_TEXT|synthetic-(read|publish|artifact)-token/);
  assert.match(readFileSync(output, "utf8"), /report_ready=true/);

  const publication = invoke("report");
  assert.ifError(publication.error);
  assert.equal(publication.status, 1, publication.stderr);
  assert.equal(publication.stderr, "");
  assert.match(JSON.parse(readFileSync(posted, "utf8")).body, /Baseline vs\. Candidate Comparison/);
  rmSync(posted);
  env.EXPECTED_HEAD = "d".repeat(40);
  const stale = invoke("report");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /PR head changed/);
  assert.equal(existsSync(posted), false);
});
