import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDefaultGraderRegistry } from "@microsoft/vally";
import { parse } from "yaml";
import {
  classifyTransition,
  compareSummaries,
  extractTrialMetrics,
  formatDuration,
  formatTokens,
  loadResults,
  renderReport,
  summarizeRun,
} from "./eval-report.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hasPrDescription = existsSync(resolve(root, "plugins/pr-description"));
const prDescriptionTest = hasPrDescription ? test : test.skip;

const makeTrial = ({
  runId = "run-1",
  evalName = "pr-description",
  stimulus = "case-1",
  status = "success",
  passed = true,
  gradeScore = passed ? 1 : 0,
  durationMs = 2400,
  inputTokens = 1100,
  outputTokens = 320,
  totalTokens = inputTokens + outputTokens,
  details = [],
  events = [],
} = {}) => ({
  type: "trial-result",
  runId,
  evalName,
  stimulus,
  status,
  durationMs,
  gradeResult: { passed, score: gradeScore, details },
  trajectory: {
    output: "Done.",
    events,
    metrics: {
      wallTimeMs: durationMs,
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens,
      },
    },
  },
});

const makeFooter = (runId = "run-1", hadExecutionErrors = false) => ({
  type: "run-summary",
  runId,
  passed: true,
  hadExecutionErrors,
  evals: [],
});

test("eval-report follows native project results configuration and retains explicit paths and defaults", async (t) => {
  const directory = resolve(root, ".github/scripts", `.report-path-test-${randomUUID()}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configured = resolve(directory, "evals/results/2026-01-01/results.jsonl");
  const legacy = resolve(directory, "vally-results/2026-02-01/results.jsonl");
  for (const [file, stimulus] of [[configured, "configured-results"], [legacy, "native-default"]]) {
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify(makeTrial({ stimulus }))}\n${JSON.stringify(makeFooter())}\n`);
  }
  const configuration = resolve(directory, ".vally.yaml");
  writeFileSync(configuration, "paths:\n  results: evals/results\n");
  assert.equal((await loadResults(undefined, directory)).file, configured);
  assert.equal((await loadResults("vally-results/2026-02-01", directory)).file, legacy);
  const cli = spawnSync(process.execPath, [resolve(root, ".github/scripts/eval-report.mjs")], {
    cwd: directory, encoding: "utf8", timeout: 10000,
  });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /configured-results/);
  assert.doesNotMatch(cli.stdout, /native-default/);
  writeFileSync(configuration, "{}\n");
  assert.equal((await loadResults(undefined, directory)).file, legacy);
  writeFileSync(configuration, "paths: [\n");
  await assert.rejects(loadResults(undefined, directory), /parse|YAML|flow sequence/i);
});

test("extractTrialMetrics and summarizeRun extract per-trial and aggregate tokens and duration", () => {
  const trial1 = makeTrial({ stimulus: "case-a", durationMs: 1500, inputTokens: 800, outputTokens: 200, totalTokens: 1000 });
  const trial2 = makeTrial({ stimulus: "case-b", durationMs: 2500, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, passed: false, gradeScore: 0.5 });

  assert.deepEqual(extractTrialMetrics(trial1), {
    durationMs: 1500,
    tokenUsage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
  });

  const summary = summarizeRun([trial1, trial2, makeFooter()]);
  assert.equal(summary.passedCount, 1);
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.errorCount, 0);
  assert.equal(summary.averageScore, 0.75);
  assert.equal(summary.totalDurationMs, 4000);
  assert.deepEqual(summary.tokenUsage, {
    inputTokens: 2000,
    outputTokens: 500,
    totalTokens: 2500,
  });
  assert.equal(formatTokens(summary.tokenUsage), "2,500 (in: 2,000, out: 500)");
  assert.equal(formatDuration(summary.totalDurationMs), "4.0s");
  assert.equal(formatDuration(450), "450ms");

  const markdown = renderReport(summary, "vally-results/run-1/results.jsonl");
  assert.match(markdown, /\| Passed \| Failed \| Avg Score \| Total Tokens \| Total Duration \|/);
  assert.match(markdown, /\| 1 \| 1 \| 75\.0% \| 2,500 \(in: 2,000, out: 500\) \| 4\.0s \|/);
  assert.match(markdown, /\| case-a \| PASS \| 100\.0% \| 1,000 \(in: 800, out: 200\) \| 1\.5s \|/);
  assert.match(markdown, /\| case-b \| BEHAVIORAL FAILURE \| 50\.0% \| 1,500 \(in: 1,200, out: 300\) \| 2\.5s \|/);
});

test("compareSummaries and renderReport surface fixed failures, regressions, and token diet reductions at parity", () => {
  const baseline = summarizeRun([
    makeTrial({
      runId: "base",
      stimulus: "pr-description-drafts-structured-pr-body",
      passed: false,
      gradeScore: 0.5,
      durationMs: 6840,
      inputTokens: 3420,
      outputTokens: 980,
      totalTokens: 4400,
    }),
    makeTrial({
      runId: "base",
      stimulus: "pr-description-ignores-bug-and-review-question",
      passed: true,
      gradeScore: 1,
      durationMs: 4120,
      inputTokens: 2150,
      outputTokens: 410,
      totalTokens: 2560,
    }),
    makeFooter("base"),
  ]);

  const candidate = summarizeRun([
    makeTrial({
      runId: "cand",
      stimulus: "pr-description-drafts-structured-pr-body",
      passed: true,
      gradeScore: 1,
      durationMs: 3910,
      inputTokens: 1680,
      outputTokens: 310,
      totalTokens: 1990,
    }),
    makeTrial({
      runId: "cand",
      stimulus: "pr-description-ignores-bug-and-review-question",
      passed: true,
      gradeScore: 1,
      durationMs: 2450,
      inputTokens: 1120,
      outputTokens: 190,
      totalTokens: 1310,
    }),
    makeFooter("cand"),
  ]);

  const comparison = compareSummaries(baseline, candidate);
  assert.equal(comparison.deltas.passed, 1);
  assert.equal(comparison.deltas.failed, -1);
  assert.equal(comparison.deltas.averageScore, 0.25);
  assert.equal(comparison.deltas.totalTokens, -3660);
  assert.equal(comparison.cases[0].transition, "Fixed");
  assert.equal(comparison.cases[1].transition, "Reduced tokens at parity");

  assert.equal(
    classifyTransition(
      { status: "PASS", score: 1, tokenUsage: { totalTokens: 1000 } },
      { status: "BEHAVIORAL FAILURE", score: 0, tokenUsage: { totalTokens: 900 } },
    ),
    "Regressed",
  );

  const markdown = renderReport(candidate, "candidate/results.jsonl", {
    baselineSummary: baseline,
    baselinePath: "baseline/results.jsonl",
  });
  assert.match(markdown, /## Baseline vs\. Candidate Comparison/);
  assert.match(markdown, /\| Total Tokens \| 6,960 \(in: 5,570, out: 1,390\) \| 3,300 \(in: 2,800, out: 500\) \| -3,660 \(-52\.6%\) \|/);
  assert.match(markdown, /\| pr-description \/ pr-description-drafts-structured-pr-body \| BEHAVIORAL FAILURE \(50\.0%\) \| PASS \(100\.0%\) \| \+50\.0% \| -2,410 \(-54\.8%\) \| Fixed \|/);
  assert.match(markdown, /\| pr-description \/ pr-description-ignores-bug-and-review-question \| PASS \(100\.0%\) \| PASS \(100\.0%\) \| 0\.0% \| -1,250 \(-48\.8%\) \| Reduced tokens at parity \|/);
  assert.match(markdown, /Single-run score, token, and duration deltas are observed signals for review/);
});

prDescriptionTest("eval-report CLI compares the shared pr-description baseline and candidate fixtures without writing GITHUB_STEP_SUMMARY", async (t) => {
  const tempDir = resolve(root, ".github/scripts", `.report-test-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const summaryFile = resolve(tempDir, "step-summary.md");
  writeFileSync(summaryFile, "");

  const baselinePath = "evals/_shared/fixtures/pr-description/baseline-results.jsonl";
  const candidatePath = "evals/_shared/fixtures/pr-description/candidate-results.jsonl";
  const loadedBase = await loadResults(baselinePath, root);
  const loadedCand = await loadResults(candidatePath, root);
  assert.equal(loadedBase.summary.passedCount, 1);
  assert.equal(loadedCand.summary.passedCount, 2);

  const result = spawnSync(
    process.execPath,
    [
      resolve(root, ".github/scripts/eval-report.mjs"),
      "--baseline",
      baselinePath,
      "--candidate",
      candidatePath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Baseline vs\. Candidate Comparison/);
  assert.match(result.stdout, /Fixed/);
  assert.match(result.stdout, /Reduced tokens at parity/);
  assert.equal(readFileSync(summaryFile, "utf8"), "");
});

test("eval-report redacts raw grader evidence and error strings, requires complete metric coverage, aggregates multi-trial cases, and guards unscored transitions", () => {
  const secretEvidence = "SECRET_TOKEN_EVIDENCE_12345";
  const secretError = "RAW_EXECUTION_ERROR_67890";
  const secretSkip = "RAW_SKIP_REASON_ABCDE";
  const secretRuntime = "RAW_RUNTIME_EVENT_FGHIJ";

  const leakedRecords = [
    makeTrial({
      runId: "leak-run",
      stimulus: "failed-case",
      passed: false,
      gradeScore: 0.5,
      details: [{ name: "pr-description-contract", passed: false, score: 0, evidence: secretEvidence }],
    }),
    {
      ...makeTrial({ runId: "leak-run", stimulus: "error-case", status: "error" }),
      error: secretError,
    },
    {
      ...makeTrial({ runId: "leak-run", stimulus: "skip-case", status: "skipped" }),
      skipReason: secretSkip,
    },
    makeTrial({
      runId: "leak-run",
      stimulus: "runtime-error-case",
      events: [{ type: "error", data: { message: secretRuntime } }],
    }),
    makeFooter("leak-run", true),
  ];

  const leakedSummary = summarizeRun(leakedRecords);
  const leakedReport = renderReport(leakedSummary, "vally-results/leak-run/results.jsonl");
  for (const secret of [secretEvidence, secretError, secretSkip, secretRuntime]) {
    assert.ok(!JSON.stringify(leakedSummary).includes(secret), `summary leaked ${secret}`);
    assert.ok(!leakedReport.includes(secret), `report leaked ${secret}`);
  }
  assert.deepEqual(leakedSummary.rows[0].failures, ["pr-description-contract"]);
  assert.deepEqual(leakedSummary.errors, [
    "error-case: execution-error",
    "skip-case: skipped",
    "runtime-error-case: runtime-error",
    "execution-error",
  ]);

  // Partial duration or token coverage must yield undefined run totals
  const missingSecondMetrics = makeTrial({ runId: "partial-run", stimulus: "case-2" });
  delete missingSecondMetrics.durationMs;
  delete missingSecondMetrics.trajectory.metrics;
  const partialSummary = summarizeRun([
    makeTrial({ runId: "partial-run", stimulus: "case-1", durationMs: 1200, inputTokens: 500, outputTokens: 100, totalTokens: 600 }),
    missingSecondMetrics,
    makeFooter("partial-run"),
  ]);
  assert.equal(partialSummary.totalDurationMs, undefined);
  assert.equal(partialSummary.tokenUsage, undefined);

  // Multi-trial aggregation per case and mismatched trial count comparison
  const multiBase = summarizeRun([
    makeTrial({ runId: "m-base", stimulus: "repeat-case", passed: true, gradeScore: 1, durationMs: 1000, inputTokens: 400, outputTokens: 100, totalTokens: 500 }),
    makeTrial({ runId: "m-base", stimulus: "repeat-case", passed: true, gradeScore: 1, durationMs: 1200, inputTokens: 500, outputTokens: 100, totalTokens: 600 }),
    makeFooter("m-base"),
  ]);
  const multiCand = summarizeRun([
    makeTrial({
      runId: "m-cand",
      stimulus: "repeat-case",
      passed: false,
      gradeScore: 0,
      durationMs: 900,
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      details: [{ name: "contract-check", passed: false, evidence: "ignored" }],
    }),
    makeTrial({
      runId: "m-cand",
      stimulus: "repeat-case",
      passed: true,
      gradeScore: 1,
      durationMs: 900,
      inputTokens: 300,
      outputTokens: 100,
      totalTokens: 400,
      details: [{ name: "contract-check", passed: false, evidence: "ignored" }],
    }),
    makeFooter("m-cand"),
  ]);
  assert.equal(multiBase.rows.length, 1);
  assert.equal(multiBase.rows[0].trials, 2);
  assert.equal(multiBase.rows[0].passedCount, 2);
  assert.equal(multiBase.rows[0].status, "PASS");
  assert.equal(multiBase.rows[0].score, 1);
  assert.equal(multiBase.rows[0].durationMs, 2200);
  assert.equal(multiBase.rows[0].tokenUsage.totalTokens, 1100);

  assert.equal(multiCand.rows.length, 1);
  assert.equal(multiCand.rows[0].trials, 2);
  assert.equal(multiCand.rows[0].passedCount, 1);
  assert.equal(multiCand.rows[0].status, "BEHAVIORAL FAILURE");
  assert.equal(multiCand.rows[0].passed, false);
  assert.equal(multiCand.rows[0].score, 0.5);
  assert.deepEqual(multiCand.rows[0].failures, ["contract-check"]);

  const multiComp = compareSummaries(multiBase, multiCand);
  assert.equal(multiComp.cases[0].transition, "Regressed");
  assert.equal(multiComp.cases[0].scoreDelta, -0.5);
  assert.equal(multiComp.cases[0].tokenDelta, -300);

  const singleTrialCand = summarizeRun([
    makeTrial({ runId: "s-cand", stimulus: "repeat-case", passed: true, gradeScore: 1, durationMs: 900, inputTokens: 300, outputTokens: 100, totalTokens: 400 }),
    makeFooter("s-cand"),
  ]);
  const mismatchedTrialsComp = compareSummaries(multiBase, singleTrialCand);
  assert.equal(mismatchedTrialsComp.cases[0].tokenDelta, undefined);
  assert.equal(mismatchedTrialsComp.cases[0].durationDeltaMs, undefined);
  assert.equal(mismatchedTrialsComp.cases[0].transition, "Unchanged");
  assert.equal(mismatchedTrialsComp.deltas.totalTokens, undefined);
  assert.equal(mismatchedTrialsComp.deltas.totalTokensPct, undefined);
  assert.equal(mismatchedTrialsComp.deltas.totalDurationMs, undefined);
  const mismatchedTrialsReport = renderReport(singleTrialCand, "cand/results.jsonl", {
    baselineSummary: multiBase,
    baselinePath: "base/results.jsonl",
  });
  assert.match(mismatchedTrialsReport, /\| Total Tokens \| 1,100 \(in: 900, out: 200\) \| 400 \(in: 300, out: 100\) \| — \|/);
  assert.match(mismatchedTrialsReport, /\| Total Duration \| 2\.2s \| 900ms \| — \|/);

  const extraCaseBase = summarizeRun([
    makeTrial({ runId: "e-base", stimulus: "repeat-case", passed: true, gradeScore: 1, durationMs: 900, inputTokens: 300, outputTokens: 100, totalTokens: 400 }),
    makeTrial({ runId: "e-base", stimulus: "extra-case", passed: true, gradeScore: 1, durationMs: 900, inputTokens: 300, outputTokens: 100, totalTokens: 400 }),
    makeFooter("e-base"),
  ]);
  const mismatchedCasesComp = compareSummaries(extraCaseBase, singleTrialCand);
  assert.equal(mismatchedCasesComp.deltas.totalTokens, undefined);
  assert.equal(mismatchedCasesComp.deltas.totalTokensPct, undefined);
  assert.equal(mismatchedCasesComp.deltas.totalDurationMs, undefined);

  // Unscored / errored transitions
  assert.equal(
    classifyTransition(
      { status: "BEHAVIORAL FAILURE", score: 0.5, tokenUsage: { totalTokens: 2000 } },
      { status: "ERROR / NOT EVALUATED", score: undefined, tokenUsage: { totalTokens: 500 } },
    ),
    "Not comparable",
  );
  assert.equal(
    classifyTransition(
      { status: "ERROR / NOT EVALUATED", score: undefined, tokenUsage: { totalTokens: 2000 } },
      { status: "ERROR / NOT EVALUATED", score: undefined, tokenUsage: { totalTokens: 500 } },
    ),
    "Not comparable",
  );
  assert.equal(
    classifyTransition(
      { status: "ERROR / NOT EVALUATED", score: undefined, tokenUsage: { totalTokens: 2000 } },
      { status: "BEHAVIORAL FAILURE", score: 0.5, tokenUsage: { totalTokens: 500 } },
    ),
    "Not comparable",
  );

  // Strip terminal escape sequences (including OSC 52) from report fields and invalid-grade errors
  const osc52Stimulus = "case-\u001b]52;c;ZWNobyBpw6g=\u0007\u001b[31mred\u001b[0m";
  const escapedSummary = summarizeRun([
    makeTrial({ runId: "osc-run", stimulus: osc52Stimulus, passed: true, gradeScore: 1 }),
    makeFooter("osc-run"),
  ]);
  const escapedReport = renderReport(escapedSummary, "vally-results/\u001b]52;c;bad\u0007/results.jsonl");
  assert.doesNotMatch(escapedReport, /\u001b|\u0007/);
  assert.throws(
    () => summarizeRun([
      {
        ...makeTrial({ runId: "bad-grade-osc", stimulus: osc52Stimulus }),
        gradeResult: { status: "success", passed: true, score: 2 },
      },
      makeFooter("bad-grade-osc"),
    ]),
    (err) => err instanceof Error && /^Invalid grade: /.test(err.message) && !/[\u001b\u0007]/.test(err.message),
  );
});

prDescriptionTest("pr-description eval stages the multi-skill marketplace cohort and enforces non-collision", async () => {
  const evalDir = resolve(root, "evals/pr-description/skills/pr-description");
  const spec = parse(readFileSync(resolve(evalDir, "eval.yaml"), "utf8"));
  assert.equal(spec.scoring.threshold, 1);
  const skills = spec.agent_environment.skills;
  assert.equal(spec.agent_environment.commands, undefined, "Local evals must not fetch a remote skill cohort.");
  for (const configuredSkill of skills) {
    assert.ok(existsSync(resolve(evalDir, configuredSkill)), `configured cohort skill path is missing: ${configuredSkill}`);
  }
  for (const expectedSkill of [
    "../../../../plugins/pr-description/skills/pr-description",
    "../../../../plugins/plugin-authoring/skills/add-plugin",
    "../../../../plugins/plugin-authoring/skills/try-plugin-locally",
    "../../../../plugins/plugin-authoring/skills/submit-plugin",
    "../../../../plugins/marketplace-maintainer/skills/update-remote-pins",
    "../../../../plugins/marketplace-maintainer/skills/release-plugins",
  ].filter((skillPath) => existsSync(resolve(evalDir, skillPath)))) {
    assert.ok(skills.includes(expectedSkill), `missing cohort skill: ${expectedSkill}`);
  }

  const grader = createDefaultGraderRegistry().get("skill-invocation");
  const positive = spec.stimuli.find((item) => item.tags?.control === "positive");
  const negative = spec.stimuli.find((item) => item.tags?.control === "negative");
  const posConfig = positive.graders.find((item) => item.type === "skill-invocation").config;
  const negConfig = negative.graders.find((item) => item.type === "skill-invocation").config;

  const exactMatch = await grader.grade({
    stimulus: positive,
    config: posConfig,
    trajectory: { output: "ok", events: [{ type: "skill_activation", data: { name: "pr-description" } }] },
  });
  assert.equal(exactMatch.passed, true);

  const neighborCollision = await grader.grade({
    stimulus: positive,
    config: posConfig,
    trajectory: {
      output: "ok",
      events: [
        { type: "skill_activation", data: { name: "pr-description" } },
        { type: "skill_activation", data: { name: "submit-plugin" } },
      ],
    },
  });
  assert.equal(neighborCollision.passed, false, "activating a neighbor skill alongside pr-description must fail");

  const negativeTriggered = await grader.grade({
    stimulus: negative,
    config: negConfig,
    trajectory: { output: "ok", events: [{ type: "skill_activation", data: { name: "pr-description" } }] },
  });
  assert.equal(negativeTriggered.passed, false, "activating pr-description on the negative case must fail");
});

prDescriptionTest("pr-description program grader enforces ordered headings, factual changes, and unshipped backlog exclusion", async (t) => {
  const gradingDir = resolve(root, ".github/scripts", `.pr-grader-test-${randomUUID()}`);
  mkdirSync(gradingDir, { recursive: true });
  t.after(() => rmSync(gradingDir, { recursive: true, force: true }));
  copyFileSync(resolve(root, "evals/pr-description/skills/pr-description/grader.mjs"), resolve(gradingDir, "grader.mjs"));
  copyFileSync(resolve(root, "evals/_shared/graders/common.mjs"), resolve(gradingDir, "common.mjs"));
  const { evaluate: evaluatePrDescription } = await import(pathToFileURL(resolve(gradingDir, "grader.mjs")));
  const { score } = await import(pathToFileURL(resolve(gradingDir, "common.mjs")));

  const validOutput = [
    "## Summary",
    "Validate `--timeout` as a positive integer in `src/cli.mjs` and add unit tests. Retry backoff (#42) remains open and out of scope.",
    "",
    "## Changes",
    "- Added positive integer validation for `--timeout` in `src/cli.mjs`.",
    "- Added unit tests for `--timeout 0` and `--timeout -5` in `test/cli.test.mjs`.",
    "",
    "## Verification",
    "- `npm test` passed (14 tests).",
    "",
    "## Risks / Rollback",
    "- Low risk; revert the commit if needed.",
  ].join("\n");

  assert.equal(score("pr-description-contract", evaluatePrDescription({ output: validOutput, events: [] })).passed, true);

  for (const passingLine of [
    "- `npm test` (14 tests): passed.",
    "- `npm test` — 14 tests, all passing.",
    "- Ran `npm test`; 14/14 tests passed.",
    "- `npm test`: 14 tests passed, 0 failed, 0 errors.",
    "- `npm test` passed (14 tests, no errors).",
    "- `npm test`: 14 passed, # fail 0, 0 failures.",
  ]) {
    const equivalentOutput = validOutput.replace("- `npm test` passed (14 tests).", passingLine);
    assert.equal(
      score("pr-description-contract", evaluatePrDescription({ output: equivalentOutput, events: [] })).passed,
      true,
      `expected passing verification format: ${passingLine}`,
    );
  }

  for (const negatedLine of [
    "- `npm test` (14 tests).",
    "- `npm test` did not pass (14 tests).",
    "- `npm test` (14 tests): not passing.",
    "- `npm test`: 14 tests; 12 passed, 2 failures.",
  ]) {
    const negatedOutput = validOutput.replace("- `npm test` passed (14 tests).", negatedLine);
    const negatedResult = score("pr-description-contract", evaluatePrDescription({ output: negatedOutput, events: [] }));
    assert.equal(negatedResult.passed, false, `expected negated verification to fail: ${negatedLine}`);
    assert.match(negatedResult.evidence, /Recorded the supplied npm test verification result/);
  }

  for (const leakedChanges of [
    "- Added unit tests for `--timeout 0` and `--timeout -5` in `test/cli.test.mjs`.\n- Implemented exponential retry backoff (#42).",
    "- Rejects `--timeout` values that are not positive integers.\n- Adds exponential retry backoff (#42).",
  ]) {
    const leaksBacklogIntoChanges = validOutput.replace(
      "- Added unit tests for `--timeout 0` and `--timeout -5` in `test/cli.test.mjs`.",
      leakedChanges,
    );
    const leakedResult = score("pr-description-contract", evaluatePrDescription({ output: leaksBacklogIntoChanges, events: [] }));
    assert.equal(leakedResult.passed, false);
    assert.match(leakedResult.evidence, /Excluded unshipped retry backoff/);
  }

  const missingRisks = validOutput.split("## Risks / Rollback")[0];
  assert.equal(score("pr-description-contract", evaluatePrDescription({ output: missingRisks, events: [] })).passed, false);

  const failedTestsClaim = validOutput.replace(
    "- `npm test` passed (14 tests).",
    "- `npm test` failed (14 tests).",
  );
  const failedTestsResult = score("pr-description-contract", evaluatePrDescription({ output: failedTestsClaim, events: [] }));
  assert.equal(failedTestsResult.passed, false);
  assert.match(failedTestsResult.evidence, /Recorded the supplied npm test verification result/);

  for (const prohibitedTool of ["bash", "functions.bash", "functions.powershell", "mcp:edit", "tools/write_file"]) {
    const toolResult = score(
      "pr-description-contract",
      evaluatePrDescription({
        output: validOutput,
        events: [{ type: "tool_call", data: { toolCallId: "1", toolName: prohibitedTool, arguments: { command: "git status" } } }],
      }),
    );
    assert.equal(toolResult.passed, false, `must reject prohibited tool ${prohibitedTool}`);
    assert.match(toolResult.evidence, /Did not run shell commands or create a pull request/);
  }
});
