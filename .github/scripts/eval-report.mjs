import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { loadProjectConfig } from "@microsoft/vally/config";

const hasGraderError = (grade) => grade?.status === "error" || (grade?.details ?? []).some(hasGraderError);
const stripTerminalControls = (text) => stripVTControlCharacters(String(text ?? ""))
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu, " ")
  .trim();
const escapeCell = (text) => stripTerminalControls(text).replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const sanitizeIdentifier = (value, fallback = "check") => {
  const cleaned = String(value ?? fallback).replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};
const sanitizeGraderId = (detail) => sanitizeIdentifier(
  typeof detail === "string" ? detail : (detail?.configuredName ?? detail?.name ?? detail?.graderType ?? "check"),
  "check",
);

export function extractTrialMetrics(record) {
  const durationMs = finiteNonNegative(record?.durationMs) ?? finiteNonNegative(record?.trajectory?.metrics?.wallTimeMs);
  const rawUsage = record?.trajectory?.metrics?.tokenUsage;
  let tokenUsage;
  if (rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)) {
    const inputTokens = finiteNonNegative(rawUsage.inputTokens);
    const outputTokens = finiteNonNegative(rawUsage.outputTokens);
    const totalTokens = finiteNonNegative(rawUsage.totalTokens)
      ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    if (totalTokens !== undefined) {
      tokenUsage = {
        totalTokens,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }
  }
  return { durationMs, tokenUsage };
}

export function formatTokens(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage.totalTokens !== "number") return "—";
  const total = tokenUsage.totalTokens.toLocaleString("en-US");
  if (typeof tokenUsage.inputTokens === "number" && typeof tokenUsage.outputTokens === "number") {
    return `${total} (in: ${tokenUsage.inputTokens.toLocaleString("en-US")}, out: ${tokenUsage.outputTokens.toLocaleString("en-US")})`;
  }
  return total;
}

export function formatDuration(durationMs) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function formatScore(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return "Not scored";
  return `${(score * 100).toFixed(1)}%`;
}

export function summarizeRun(records) {
  if (!Array.isArray(records) || !records.length || records.at(-1)?.type !== "run-summary") {
    throw new Error("The run has no completion summary.");
  }
  const runIds = new Set(records.map((record) => record?.runId));
  if (runIds.size !== 1 || typeof records[0].runId !== "string") {
    throw new Error("Missing or mixed run identities.");
  }

  const caseGroups = new Map();
  const errors = [];
  let passedCount = 0;
  let failedCount = 0;
  let errorCount = 0;
  let scoredCount = 0;
  let scoreSum = 0;
  let totalDurationMs = 0;
  let allTrialsHaveDuration = true;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let allTrialsHaveTokens = true;
  let hasInOutTokens = true;
  let trialCount = 0;

  for (const record of records) {
    if (record.type === "run-summary") {
      if (typeof record.hadExecutionErrors !== "boolean") throw new Error("Invalid run summary.");
      if (record.hadExecutionErrors) errors.push("execution-error");
      continue;
    }
    if (record.type !== "trial-result" || typeof record.stimulus !== "string" || !record.stimulus.trim()) {
      throw new Error("Unexpected trial identity.");
    }
    if (!["success", "error", "skipped"].includes(record.status)) {
      throw new Error("Unknown trial status.");
    }
    trialCount++;

    const grade = record.gradeResult;
    const runtimeErrors = (record.trajectory?.events ?? []).filter((event) => event.type === "error");
    const fatalCode = record.status === "skipped"
      ? "skipped"
      : record.status !== "success"
        ? "execution-error"
        : !grade || hasGraderError(grade)
          ? "grader-error"
          : runtimeErrors.length > 0
            ? "runtime-error"
            : undefined;
    const fatal = fatalCode !== undefined;
    if (!fatal && (typeof grade.passed !== "boolean" || !Number.isFinite(grade.score) || grade.score < 0 || grade.score > 1)) {
      throw new Error(`Invalid grade: ${sanitizeIdentifier(record.stimulus, "trial")}`);
    }
    if (fatal) {
      errorCount++;
      errors.push(`${sanitizeIdentifier(record.stimulus, "trial")}: ${fatalCode}`);
    } else if (grade.passed) {
      passedCount++;
      scoredCount++;
      scoreSum += grade.score;
    } else {
      failedCount++;
      scoredCount++;
      scoreSum += grade.score;
    }

    const { durationMs, tokenUsage } = extractTrialMetrics(record);
    if (durationMs !== undefined) {
      totalDurationMs += durationMs;
    } else {
      allTrialsHaveDuration = false;
    }
    if (tokenUsage !== undefined) {
      totalTokens += tokenUsage.totalTokens;
      if (typeof tokenUsage.inputTokens === "number" && typeof tokenUsage.outputTokens === "number") {
        totalInputTokens += tokenUsage.inputTokens;
        totalOutputTokens += tokenUsage.outputTokens;
      } else {
        hasInOutTokens = false;
      }
    } else {
      allTrialsHaveTokens = false;
    }

    const evalName = typeof record.evalName === "string" && record.evalName.trim() ? record.evalName.trim() : undefined;
    const groupKey = `${evalName ?? ""}\0${record.stimulus}`;
    let group = caseGroups.get(groupKey);
    if (!group) {
      group = {
        evalName,
        name: record.stimulus,
        trials: 0,
        passedCount: 0,
        hasFatal: false,
        allPassed: true,
        allScored: true,
        scoreSum: 0,
        allHaveDuration: true,
        durationSum: 0,
        allHaveTokens: true,
        allHaveInOutTokens: true,
        totalTokensSum: 0,
        inputTokensSum: 0,
        outputTokensSum: 0,
        failures: new Set(),
      };
      caseGroups.set(groupKey, group);
    }

    group.trials++;
    if (fatal) {
      group.hasFatal = true;
      group.allPassed = false;
      group.allScored = false;
    } else {
      if (grade.passed) {
        group.passedCount++;
      } else {
        group.allPassed = false;
      }
      group.scoreSum += grade.score;
    }

    if (durationMs !== undefined) {
      group.durationSum += durationMs;
    } else {
      group.allHaveDuration = false;
    }

    if (tokenUsage !== undefined) {
      group.totalTokensSum += tokenUsage.totalTokens;
      if (typeof tokenUsage.inputTokens === "number" && typeof tokenUsage.outputTokens === "number") {
        group.inputTokensSum += tokenUsage.inputTokens;
        group.outputTokensSum += tokenUsage.outputTokens;
      } else {
        group.allHaveInOutTokens = false;
      }
    } else {
      group.allHaveTokens = false;
      group.allHaveInOutTokens = false;
    }

    for (const detail of (grade?.details ?? [])) {
      if (!detail.passed) {
        group.failures.add(sanitizeGraderId(detail));
      }
    }
  }

  if (!trialCount) throw new Error("No cases were evaluated.");

  const rows = [...caseGroups.values()].map((group) => {
    const passed = !group.hasFatal && group.allPassed;
    const status = group.hasFatal ? "ERROR / NOT EVALUATED" : passed ? "PASS" : "BEHAVIORAL FAILURE";
    return {
      evalName: group.evalName,
      name: group.name,
      trials: group.trials,
      passedCount: group.passedCount,
      status,
      passed,
      score: !group.hasFatal && group.allScored ? group.scoreSum / group.trials : undefined,
      durationMs: group.allHaveDuration ? group.durationSum : undefined,
      tokenUsage: group.allHaveTokens
        ? {
            totalTokens: group.totalTokensSum,
            ...(group.allHaveInOutTokens
              ? { inputTokens: group.inputTokensSum, outputTokens: group.outputTokensSum }
              : {}),
          }
        : undefined,
      failures: [...group.failures],
    };
  });

  return {
    runId: records[0].runId,
    rows,
    errors,
    passedCount,
    failedCount,
    errorCount,
    averageScore: scoredCount > 0 ? scoreSum / scoredCount : undefined,
    totalDurationMs: allTrialsHaveDuration ? totalDurationMs : undefined,
    tokenUsage: allTrialsHaveTokens
      ? {
          totalTokens,
          ...(hasInOutTokens ? { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } : {}),
        }
      : undefined,
  };
}

function caseKey(row, useEvalPrefix) {
  return useEvalPrefix && row.evalName ? `${row.evalName} / ${row.name}` : row.name;
}

export function classifyTransition(baselineRow, candidateRow) {
  if (!baselineRow) return "Added";
  if (!candidateRow) return "Removed";
  if (baselineRow.status !== "PASS" && candidateRow.status === "PASS") return "Fixed";
  if (baselineRow.status === "PASS" && candidateRow.status !== "PASS") return "Regressed";
  if (baselineRow.status === "BEHAVIORAL FAILURE" && candidateRow.status === "ERROR / NOT EVALUATED") return "Regressed";
  if (baselineRow.status === "ERROR / NOT EVALUATED" || candidateRow.status === "ERROR / NOT EVALUATED") return "Unchanged";
  if (typeof baselineRow.score !== "number" || !Number.isFinite(baselineRow.score)
    || typeof candidateRow.score !== "number" || !Number.isFinite(candidateRow.score)) {
    return "Unchanged";
  }
  if (candidateRow.score > baselineRow.score) return "Improved score";
  if (candidateRow.score < baselineRow.score) return "Regressed";
  if (baselineRow.status === candidateRow.status && (baselineRow.trials ?? 1) === (candidateRow.trials ?? 1)) {
    const baseTokens = baselineRow.tokenUsage?.totalTokens;
    const candTokens = candidateRow.tokenUsage?.totalTokens;
    if (typeof baseTokens === "number" && typeof candTokens === "number") {
      if (candTokens < baseTokens) return "Reduced tokens at parity";
      if (candTokens > baseTokens) return "Increased tokens at parity";
    }
  }
  return "Unchanged";
}

export function compareSummaries(baseline, candidate) {
  const useEvalPrefix = baseline.rows.every((row) => Boolean(row.evalName))
    && candidate.rows.every((row) => Boolean(row.evalName));
  const baselineMap = new Map(baseline.rows.map((row) => [caseKey(row, useEvalPrefix), row]));
  const candidateMap = new Map(candidate.rows.map((row) => [caseKey(row, useEvalPrefix), row]));
  const keys = [...new Set([...baselineMap.keys(), ...candidateMap.keys()])];

  const cases = keys.map((key) => {
    const baseRow = baselineMap.get(key);
    const candRow = candidateMap.get(key);
    const sameTrialCount = (baseRow?.trials ?? 1) === (candRow?.trials ?? 1);
    const scoreDelta = typeof baseRow?.score === "number" && typeof candRow?.score === "number"
      ? candRow.score - baseRow.score
      : undefined;
    const baseTokens = baseRow?.tokenUsage?.totalTokens;
    const candTokens = candRow?.tokenUsage?.totalTokens;
    const tokenDelta = sameTrialCount && typeof baseTokens === "number" && typeof candTokens === "number"
      ? candTokens - baseTokens
      : undefined;
    const tokenDeltaPct = tokenDelta !== undefined && baseTokens > 0
      ? (tokenDelta / baseTokens) * 100
      : undefined;
    const durationDeltaMs = sameTrialCount && typeof baseRow?.durationMs === "number" && typeof candRow?.durationMs === "number"
      ? candRow.durationMs - baseRow.durationMs
      : undefined;

    return {
      key,
      baseline: baseRow,
      candidate: candRow,
      scoreDelta,
      tokenDelta,
      tokenDeltaPct,
      durationDeltaMs,
      transition: classifyTransition(baseRow, candRow),
    };
  });

  const workloadsMatch =
    baseline.rows.length === candidate.rows.length &&
    cases.every((item) => item.baseline && item.candidate && item.baseline.trials === item.candidate.trials);
  const baseTotalTokens = baseline.tokenUsage?.totalTokens;
  const candTotalTokens = candidate.tokenUsage?.totalTokens;
  const totalTokenDelta = workloadsMatch && typeof baseTotalTokens === "number" && typeof candTotalTokens === "number"
    ? candTotalTokens - baseTotalTokens
    : undefined;
  const totalTokenDeltaPct = totalTokenDelta !== undefined && baseTotalTokens > 0
    ? (totalTokenDelta / baseTotalTokens) * 100
    : undefined;

  return {
    baseline,
    candidate,
    cases,
    deltas: {
      passed: candidate.passedCount - baseline.passedCount,
      failed: (candidate.failedCount + candidate.errorCount) - (baseline.failedCount + baseline.errorCount),
      averageScore: typeof baseline.averageScore === "number" && typeof candidate.averageScore === "number"
        ? candidate.averageScore - baseline.averageScore
        : undefined,
      totalTokens: totalTokenDelta,
      totalTokensPct: totalTokenDeltaPct,
      totalDurationMs: workloadsMatch && typeof baseline.totalDurationMs === "number" && typeof candidate.totalDurationMs === "number"
        ? candidate.totalDurationMs - baseline.totalDurationMs
        : undefined,
    },
  };
}

function formatSignedInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

function formatScoreDelta(delta) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "—";
  const points = delta * 100;
  if (Math.abs(points) < 0.05) return "0.0%";
  return `${points > 0 ? "+" : ""}${points.toFixed(1)}%`;
}

function formatTokenDelta(delta, pct) {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return "—";
  if (delta === 0) return "0 (0.0%)";
  const sign = delta > 0 ? "+" : "";
  const pctText = typeof pct === "number" && Number.isFinite(pct)
    ? ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
    : "";
  return `${sign}${delta.toLocaleString("en-US")}${pctText}`;
}

function formatDurationDelta(deltaMs) {
  if (typeof deltaMs !== "number" || !Number.isFinite(deltaMs)) return "—";
  if (deltaMs === 0) return "0.0s";
  const sign = deltaMs > 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(deltaMs))}`;
}

export function renderReport(summary, path, { baselineSummary, baselinePath } = {}) {
  const lines = [
    "## Behavioral eval report",
    "",
    `Saved run: \`${escapeCell(path)}\``,
    "",
    "| Passed | Failed | Avg Score | Total Tokens | Total Duration |",
    "| --- | --- | --- | --- | --- |",
    `| ${summary.passedCount} | ${summary.failedCount + summary.errorCount} | ${formatScore(summary.averageScore)} | ${formatTokens(summary.tokenUsage)} | ${formatDuration(summary.totalDurationMs)} |`,
    "",
    "| Case | Verdict | Score | Tokens | Duration |",
    "| --- | --- | --- | --- | --- |",
    ...summary.rows.map((row) =>
      `| ${escapeCell(row.name)} | ${row.status} | ${formatScore(row.score)} | ${formatTokens(row.tokenUsage)} | ${formatDuration(row.durationMs)} |`),
    "",
  ];

  const failureLines = summary.rows.flatMap((row) =>
    row.failures.map((grader) => `- ${escapeCell(row.name)} / ${escapeCell(sanitizeGraderId(grader))}: check failed`));
  const errorLines = summary.errors.map((error) => `- ERROR: ${escapeCell(error)}`);
  if (failureLines.length || errorLines.length) {
    lines.push(...failureLines, ...errorLines, "");
  }

  if (baselineSummary) {
    const comparison = compareSummaries(baselineSummary, summary);
    lines.push(
      "## Baseline vs. Candidate Comparison",
      "",
      ...(baselinePath ? [`Baseline: \`${escapeCell(baselinePath)}\` | Candidate: \`${escapeCell(path)}\``, ""] : []),
      "| Metric | Baseline | Candidate | Delta |",
      "| --- | --- | --- | --- |",
      `| Passed | ${baselineSummary.passedCount} | ${summary.passedCount} | ${formatSignedInt(comparison.deltas.passed)} |`,
      `| Failed | ${baselineSummary.failedCount + baselineSummary.errorCount} | ${summary.failedCount + summary.errorCount} | ${formatSignedInt(comparison.deltas.failed)} |`,
      `| Avg Score | ${formatScore(baselineSummary.averageScore)} | ${formatScore(summary.averageScore)} | ${formatScoreDelta(comparison.deltas.averageScore)} |`,
      `| Total Tokens | ${formatTokens(baselineSummary.tokenUsage)} | ${formatTokens(summary.tokenUsage)} | ${formatTokenDelta(comparison.deltas.totalTokens, comparison.deltas.totalTokensPct)} |`,
      `| Total Duration | ${formatDuration(baselineSummary.totalDurationMs)} | ${formatDuration(summary.totalDurationMs)} | ${formatDurationDelta(comparison.deltas.totalDurationMs)} |`,
      "",
      "| Case | Baseline | Candidate | Score Delta | Token Delta | Transition |",
      "| --- | --- | --- | --- | --- | --- |",
      ...comparison.cases.map((item) => {
        const baseCell = item.baseline ? `${item.baseline.status} (${formatScore(item.baseline.score)})` : "—";
        const candCell = item.candidate ? `${item.candidate.status} (${formatScore(item.candidate.score)})` : "—";
        return `| ${escapeCell(item.key)} | ${baseCell} | ${candCell} | ${formatScoreDelta(item.scoreDelta)} | ${formatTokenDelta(item.tokenDelta, item.tokenDeltaPct)} | ${item.transition} |`;
      }),
      "",
      "> **Note:** Single-run score, token, and duration deltas are observed signals for review rather than multi-trial statistical proof.",
      "",
    );
  }

  return lines.join("\n");
}

export async function resolveResultsPath(input, root = process.cwd()) {
  if (!input) {
    const config = await loadProjectConfig(root);
    const base = resolve(config.dir || root, config.paths.results);
    const display = relative(root, base).split(sep).join("/") || ".";
    if (!existsSync(base)) {
      throw new Error(`No saved eval runs under ${display}/. Run evals first, or pass --results <path>.`);
    }
    const runs = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(base, entry.name, "results.jsonl")))
      .map((entry) => entry.name)
      .sort();
    if (!runs.length) {
      throw new Error(`No saved eval runs under ${display}/. Run evals first, or pass --results <path>.`);
    }
    return resolve(base, runs.at(-1), "results.jsonl");
  }
  const resolved = resolve(root, input);
  if (!existsSync(resolved)) {
    throw new Error(`${relative(root, resolved).split(sep).join("/")} doesn't exist.`);
  }
  if (statSync(resolved).isDirectory()) {
    const file = resolve(resolved, "results.jsonl");
    if (!existsSync(file)) {
      throw new Error(`${relative(root, file).split(sep).join("/")} doesn't exist.`);
    }
    return file;
  }
  return resolved;
}

export async function loadResults(path, root = process.cwd()) {
  const file = await resolveResultsPath(path, root);
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const records = lines.map((line) => JSON.parse(line));
  const displayPath = relative(root, file).split(sep).join("/") || file;
  return { file, displayPath, summary: summarizeRun(records) };
}

export const usage = `Usage: node .github/scripts/eval-report.mjs [options]

Reads Vally results.jsonl files and prints a Markdown report with per-case and
aggregate verdicts, scores, token usage (input, output, total), and duration.
When --baseline is supplied, also prints a Baseline vs. Candidate comparison
table highlighting fixed failures, regressions, and token deltas.

Options:
  --results, --candidate, --run-dir <path>
                    Candidate results.jsonl file or run directory. Defaults to
                    the newest run under .vally.yaml's paths.results (Vally's
                    default is vally-results/ when not configured).
  --baseline <path> Baseline results.jsonl file or run directory to compare
                    against the candidate run.
  -h, --help        Show this help message.

Examples:
  npm run eval:report
  npm run eval:compare -- --baseline evals/_shared/fixtures/pr-description/baseline-results.jsonl --candidate evals/_shared/fixtures/pr-description/candidate-results.jsonl`;

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        results: { type: "string" },
        candidate: { type: "string" },
        "run-dir": { type: "string" },
        baseline: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    throw new Error(`${error.message}. Run npm run eval:report -- --help for options.`);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length > 2) {
    throw new Error("Pass at most two positional paths ([results] or [baseline] [candidate]). Run npm run eval:report -- --help for options.");
  }

  const baselineInput = values.baseline ?? (positionals.length === 2 ? positionals[0] : undefined);
  const candidateInput = values.candidate ?? values.results ?? values["run-dir"]
    ?? (positionals.length === 2 ? positionals[1] : positionals[0]);
  const candidate = await loadResults(candidateInput);
  const baseline = baselineInput ? await loadResults(baselineInput) : undefined;
  const markdown = renderReport(candidate.summary, candidate.displayPath, {
    baselineSummary: baseline?.summary,
    baselinePath: baseline?.displayPath,
  });
  console.log(markdown);
  if (candidate.summary.errors.length || baseline?.summary.errors.length) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
