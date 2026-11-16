import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { isEntrypoint } from "./entrypoint.mjs";
import { extractTrialMetrics, renderReport, summarizeRun } from "./eval-report.mjs";

const skillPath = "plugins/commit-attribution/skills/commit/";
const evalPath = "evals/commit-attribution/skills/commit/commit.eval.yaml";
const marker = "<!-- commit-attribution-eval-comparison -->";
const sha = /^[a-f0-9]{40}$/;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const digest = (content) => createHash("sha256").update(content).digest("hex");
const hasGraderError = (grade) => grade?.status === "error" || (grade?.details ?? []).some(hasGraderError);
const api = (path, body) => JSON.parse(execFileSync("gh", [
  "api", path, ...(body ? ["--method", "POST", "--input", "-"] : []),
], { encoding: "utf8", input: body && JSON.stringify(body), timeout: 60000, maxBuffer: 16 * 1024 * 1024 }));
const output = (name, value) => appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);

export function checksFingerprint(tree) {
  return digest(JSON.stringify(tree.tree
    .filter((entry) => entry.type !== "tree" && (
      /^(evals\/|\.github\/scripts\/|\.github\/workflows\/)/.test(entry.path)
      || [".vally.yaml", "package.json", "package-lock.json", ".npmrc"].includes(entry.path)))
    .map(({ path, sha: revision, mode }) => [path, revision, mode]).sort((a, b) => a[0].localeCompare(b[0]))));
}

export function validatePullRequest(pr, repository, number, expectedHead) {
  if (!repositoryName.test(repository) || !/^[1-9]\d*$/.test(String(number)) || !sha.test(expectedHead)) {
    throw new Error("Provide a repository, positive PR number, and exact 40-character head SHA.");
  }
  if (pr.number !== Number(number) || pr.state !== "open" || pr.base?.repo?.full_name !== repository || pr.base.ref !== "main") {
    throw new Error("The comparison requires an open PR targeting this repository's main branch.");
  }
  if (pr.head?.sha !== expectedHead || !sha.test(pr.base.sha) || !repositoryName.test(pr.head.repo?.full_name ?? "")) {
    throw new Error("The PR head changed or is unavailable. Review the current commit before dispatching again.");
  }
  return { repository, pr: Number(number), base: pr.base.sha, head: expectedHead, headRepository: pr.head.repo.full_name };
}

export function authorizePullRequest(pr, { repository, eventName, actor, triggeringActor }, permissionFor) {
  const manual = eventName === "workflow_dispatch";
  if (!manual && eventName !== "pull_request_target") throw new Error("Unsupported eval trigger.");
  if (!manual && (pr.head.repo.full_name !== repository || pr.draft || pr.user?.type !== "User")) {
    return { allowed: false, reason: "Fork, draft, or bot PRs require an exact-head maintainer dispatch." };
  }
  const users = [...new Set([actor, triggeringActor, ...(!manual ? [pr.user?.login] : [])])];
  if (users.some((login) => typeof login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login))) {
    return { allowed: false, reason: "A human author, actor, and rerun actor must be identifiable." };
  }
  for (const login of users) {
    const result = permissionFor(login);
    if (result?.user?.login?.toLowerCase() !== login.toLowerCase()
      || !["none", "read", "triage", "write", "maintain", "admin"].includes(result.permission)) {
      throw new Error("GitHub returned an invalid collaborator permission response.");
    }
    // GitHub reports the standard maintain role as permission=write.
    const maintainer = ["admin", "maintain"].includes(result.permission) || result.role_name === "maintain";
    const writer = maintainer || result.permission === "write" || result.permission === "maintain";
    if (manual ? !maintainer : !writer) {
      return {
        allowed: false,
        reason: manual
          ? "Manual approval and reruns require repository maintain or admin access."
          : "Automatic evals require current write access for the PR author, actor, and rerun actor.",
      };
    }
  }
  return { allowed: true, reason: manual ? "Maintainer approved this exact PR head." : "Same-repository contributor permissions verified." };
}

function checkedRequest() {
  if (process.env.GITHUB_REF !== "refs/heads/main"
    || !["workflow_dispatch", "pull_request_target"].includes(process.env.GITHUB_EVENT_NAME)) {
    throw new Error("Use a trusted main workflow through a PR event or an exact-head dispatch.");
  }
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const expectedHead = process.env.EXPECTED_HEAD;
  if (!repositoryName.test(repository ?? "") || !/^[1-9]\d*$/.test(number ?? "") || !sha.test(expectedHead ?? "")) {
    throw new Error("A valid repository, PR number, and exact head SHA are required.");
  }
  const pr = api(`repos/${repository}/pulls/${number}`);
  const identity = validatePullRequest(pr, repository, number, expectedHead);
  const decision = authorizePullRequest(pr, {
    repository, eventName: process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR, triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
  }, (login) => api(`repos/${repository}/collaborators/${login}/permission`));
  return { identity, decision };
}

function authorize() {
  const { decision } = checkedRequest();
  output("authorized", decision.allowed);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## PR eval authorization\n\n${decision.reason}\n`);
  if (!decision.allowed && process.env.GITHUB_EVENT_NAME === "workflow_dispatch") throw new Error(decision.reason);
}

export function selectSkillFiles(tree) {
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GitHub returned an incomplete source tree.");
  const files = tree.tree.filter((entry) => entry.path.startsWith(skillPath) && entry.type !== "tree");
  if (!files.length || files.length > 64 || !files.some((entry) => entry.path === `${skillPath}SKILL.md`)) {
    throw new Error("The revision must contain the commit skill and at most 64 skill files.");
  }
  for (const entry of files) {
    const parts = entry.path.slice(skillPath.length).split("/");
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode) || !sha.test(entry.sha)
      || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))
      || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error("Skill snapshots support regular files only, without symlinks or traversal.");
    }
  }
  if (files.reduce((size, entry) => size + entry.size, 0) > 2 * 1024 * 1024) throw new Error("Skill snapshot exceeds 2 MiB.");
  return files;
}

function definition(root) {
  const content = readFileSync(resolve(root, evalPath), "utf8");
  const spec = parse(content);
  if (spec.tags?.suite !== "smoke" || spec.defaults?.runs !== 1 || spec.defaults?.executor !== "copilot-sdk") {
    throw new Error("This comparison supports the one-trial commit-attribution smoke eval only.");
  }
  return {
    content, hash: digest(content), name: spec.name,
    cases: spec.stimuli.map((stimulus) => stimulus.name),
    checks: spec.stimuli.flatMap((stimulus) => stimulus.graders.map((grader) => grader.name ?? grader.type)),
  };
}

export function projectResults(records, expected, model) {
  summarizeRun(records);
  const trials = records.filter((record) => record.type === "trial-result");
  if (trials.length !== expected.cases.length || new Set(trials.map((trial) => trial.stimulus)).size !== trials.length) {
    throw new Error("Results do not contain exactly one trial for every expected case.");
  }
  const projected = trials.map((trial) => {
    if (trial.evalName !== expected.name || !expected.cases.includes(trial.stimulus)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(trial.runId)) throw new Error("Unexpected result identity.");
    if (trial.status === "success" && trial.trajectory?.metadata?.model !== model) {
      throw new Error("Recorded model is missing or differs from the pinned model.");
    }
    const metrics = extractTrialMetrics(trial);
    const grade = trial.gradeResult;
    if (grade && !hasGraderError(grade) && (typeof grade.passed !== "boolean"
      || !Number.isFinite(grade.score) || grade.score < 0 || grade.score > 1)) {
      throw new Error("Result contains an invalid grade.");
    }
    return {
      type: "trial-result", runId: trial.runId, evalName: trial.evalName,
      stimulus: trial.stimulus, status: trial.status, durationMs: metrics.durationMs,
      ...(grade && { gradeResult: hasGraderError(grade) ? { status: "error", passed: false, score: 0 } : {
        passed: grade.passed, score: grade.score,
        details: (grade.details ?? []).filter((detail) => detail.passed === false).map((detail) => ({
          name: expected.checks.includes(detail.configuredName ?? detail.name) ? (detail.configuredName ?? detail.name) : "check",
          passed: false,
        })),
      } }),
      trajectory: {
        metadata: { model: trial.status === "success" ? model : undefined },
        metrics: { tokenUsage: metrics.tokenUsage },
        events: (trial.trajectory?.events ?? []).some((event) => event.type === "error") ? [{ type: "error" }] : [],
      },
    };
  });
  projected.push({ type: "run-summary", runId: records.at(-1).runId, hadExecutionErrors: records.at(-1).hadExecutionErrors });
  summarizeRun(projected);
  return projected;
}

export function renderComparison(bundle, expected, model, identity, runUrl) {
  for (const key of ["repository", "pr", "base", "head", "harness", "checksChanged"]) {
    if (bundle[key] !== identity[key]) throw new Error(`Comparison ${key} does not match the approved run.`);
  }
  if (bundle.version !== 1 || bundle.model !== model || bundle.evalHash !== expected.hash) {
    throw new Error("Comparison model or eval definition does not match the trusted run.");
  }
  const lines = [
    marker, "## Commit attribution evals", "",
    `Configured model: \`${model}\`. Same smoke eval and one trial per case on both revisions.`,
    `Base: \`${identity.base}\`. Candidate: \`${identity.head}\`.`,
    `Trusted checks and runner: \`${identity.harness}\`. [Actions run](${runUrl}).`, "",
  ];
  if (identity.checksChanged) {
    lines.push("**Checks or execution settings differ between these revisions. This table uses the unchanged checks from the trusted workflow revision, not the PR's modified tests.**", "");
  }
  let failed = false;
  const summaries = {};
  for (const side of ["baseline", "candidate"]) {
    const arm = bundle[side];
    if (!arm || !Number.isInteger(arm.exitCode) || arm.exitCode < 0 || arm.exitCode > 255) {
      throw new Error("Missing or invalid execution status.");
    }
    if (arm.problem === "results-unavailable") {
      lines.push(`**${side}: execution or result-processing error. No score available.**`, "");
      failed = true;
    } else {
      if (arm.problem !== undefined) throw new Error("Unknown result-processing status.");
      const summary = summarizeRun(projectResults(arm.records, expected, model));
      summaries[side] = summary;
      failed ||= arm.exitCode !== 0 || summary.failedCount > 0 || summary.errors.length > 0;
      if (arm.exitCode !== 0) lines.push(`${side} runner exited with code ${arm.exitCode}.`, "");
    }
  }
  if (summaries.candidate) {
    lines.push(renderReport(summaries.candidate, "candidate", {
      baselineSummary: summaries.baseline, baselinePath: "baseline",
    }));
  } else if (summaries.baseline) lines.push(renderReport(summaries.baseline, "baseline"));
  lines.push(
    "PR changes to evals, graders, dependencies, and workflows are not used in this comparison. Review those changes separately.",
    "Single-trial differences are review signals, not proof of improvement. Tokens are not a monetary cost estimate.",
    "",
    "_🤖 Posted by GitHub Copilot on Harald's behalf._",
  );
  return { markdown: lines.join("\n"), failed };
}

function prepare(root) {
  const { identity, decision } = checkedRequest();
  if (!decision.allowed) throw new Error(decision.reason);
  if (!sha.test(process.env.GITHUB_SHA ?? "")) throw new Error("The trusted workflow revision is missing.");
  const expected = definition(root);
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP, "attribution-pr-"));
  const fingerprints = [];
  for (const [side, sourceRepository, revision] of [
    ["baseline", identity.repository, identity.base],
    ["candidate", identity.headRepository, identity.head],
  ]) {
    const snapshot = join(directory, side);
    const tree = api(`repos/${sourceRepository}/git/trees/${revision}?recursive=1`);
    const files = selectSkillFiles(tree);
    fingerprints.push(checksFingerprint(tree));
    for (const file of files) {
      const blob = api(`repos/${sourceRepository}/git/blobs/${file.sha}`);
      if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding.");
      const bytes = Buffer.from(blob.content, "base64");
      if (bytes.length !== file.size) throw new Error("Skill blob size changed during capture.");
      const destination = join(snapshot, file.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: file.mode === "100755" ? 0o755 : 0o644 });
    }
    mkdirSync(dirname(join(snapshot, evalPath)), { recursive: true });
    writeFileSync(join(snapshot, evalPath), expected.content);
  }
  writeFileSync(join(directory, "plan.json"), JSON.stringify({
    version: 1, ...identity, harness: process.env.GITHUB_SHA,
    model: process.env.EVAL_MODEL, evalHash: expected.hash, checksChanged: fingerprints[0] !== fingerprints[1],
  }));
  output("directory", directory);
  output("base", identity.base);
  output("checks_changed", fingerprints[0] !== fingerprints[1]);
}

function run(root) {
  const directory = process.env.COMPARISON_DIR;
  const bundle = JSON.parse(readFileSync(join(directory, "plan.json"), "utf8"));
  const expected = definition(root);
  if (bundle.evalHash !== expected.hash || bundle.model !== process.env.EVAL_MODEL) throw new Error("Prepared inputs changed.");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith("ACTIONS_") && !key.startsWith("GITHUB_") && !key.startsWith("GIT_")
    && !key.startsWith("COPILOT_") && !["GH_TOKEN", "NODE_OPTIONS", "NODE_PATH"].includes(key)));
  Object.assign(env, {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    COPILOT_CLI_PATH: resolve(root, "node_modules/@github/copilot/npm-loader.js"),
    COPILOT_AUTO_UPDATE: "false",
  });
  for (const side of ["baseline", "candidate"]) {
    const snapshot = join(directory, side);
    const results = join(directory, `${side}-results`);
    const execution = spawnSync(process.execPath, [
      resolve(root, "node_modules/@microsoft/vally-cli/dist/index.js"), "eval",
      "--eval-spec", join(snapshot, evalPath), "--model", bundle.model,
      "--workers", "1", "--max-retries", "0", "--timeout", "2m", "--shutdown-timeout", "20s",
      "--work-dir", snapshot, "--workspace", join(directory, `${side}-workspaces`),
      "--output-dir", results, "--require-pass",
    ], { cwd: snapshot, env, stdio: "inherit", timeout: 6 * 60 * 1000 });
    const arm = { exitCode: execution.status ?? 1 };
    if (execution.error || execution.signal) console.error(`${side}: evaluator did not exit normally.`);
    try {
      const runs = readdirSync(results).filter((entry) => statSync(join(results, entry)).isDirectory());
      if (runs.length !== 1) throw new Error("Expected one results directory.");
      const file = join(results, runs[0], "results.jsonl");
      if (statSync(file).size > 16 * 1024 * 1024) throw new Error("Results exceed the report size limit.");
      arm.records = projectResults(readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)), expected, bundle.model);
    } catch (error) {
      arm.problem = "results-unavailable";
      console.error(`${side}: results are incomplete, invalid, or use a different model (${error.name}). Inspect the evaluator logs.`);
    }
    bundle[side] = arm;
  }
  writeFileSync(join(process.env.RUNNER_TEMP, "pr-eval-report.json"), JSON.stringify(bundle));
  output("report_ready", "true");
  const report = renderComparison(bundle, expected, bundle.model, bundle,
    `https://github.com/${bundle.repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.markdown);
  if (report.failed) process.exitCode = 1;
}

function report(root) {
  const repository = process.env.GITHUB_REPOSITORY;
  const number = process.env.PR_NUMBER;
  const expectedHead = process.env.EXPECTED_HEAD;
  if (!repositoryName.test(repository ?? "") || !/^[1-9]\d*$/.test(number ?? "") || !sha.test(expectedHead ?? "")) {
    throw new Error("Invalid PR report destination.");
  }
  validatePullRequest(api(`repos/${repository}/pulls/${number}`), repository, number, expectedHead);
  const file = join(process.env.REPORT_DIR, "pr-eval-report.json");
  if (statSync(file).size > 128 * 1024) throw new Error("Comparison artifact exceeds the report size limit.");
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const result = renderComparison(bundle, definition(root), process.env.EVAL_MODEL, {
    repository, pr: Number(number), base: process.env.EXPECTED_BASE,
    head: expectedHead, harness: process.env.GITHUB_SHA, checksChanged: process.env.CHECKS_CHANGED === "true",
  }, `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  const pages = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/issues/${number}/comments`, "--paginate", "--slurp"], {
    encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  }));
  const previous = pages.flat().find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker));
  validatePullRequest(api(`repos/${repository}/pulls/${number}`), repository, number, expectedHead);
  if (previous) {
    execFileSync("gh", ["api", `repos/${repository}/issues/comments/${previous.id}`, "--method", "PATCH", "--input", "-"], {
      input: JSON.stringify({ body: result.markdown }), stdio: ["pipe", "ignore", "inherit"], timeout: 60000,
    });
  } else api(`repos/${repository}/issues/${number}/comments`, { body: result.markdown });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.markdown);
  if (result.failed) process.exitCode = 1;
}

if (isEntrypoint(import.meta.url)) {
  try {
    const command = process.argv[2];
    const root = process.cwd();
    if (command === "authorize") authorize();
    else if (command === "prepare") prepare(root);
    else if (command === "run") run(root);
    else if (command === "report") report(root);
    else throw new Error("Usage: node .github/scripts/commit-attribution-pr.mjs <authorize|prepare|run|report>");
  } catch (error) {
    console.error(`commit-attribution-pr: ${error.message}`);
    process.exitCode = 1;
  }
}
