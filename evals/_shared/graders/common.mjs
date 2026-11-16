import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const real = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
export const check = (label, passed) => ({ label, passed: Boolean(passed) });
// Real paths, because Node resolves import.meta.url through symlinks but not argv.
export const isMain = (url) => Boolean(process.argv[1]) && real(resolve(process.argv[1])) === real(fileURLToPath(url));
export const normalize = (text) => text.replaceAll("\r\n", "\n");
export const json = (workspace, path) => {
  const file = resolve(workspace, path);
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};
export const text = (workspace, path) => existsSync(resolve(workspace, path)) ? readFileSync(resolve(workspace, path), "utf8") : "";
export const matchesTool = (name, suffix) => typeof name === "string"
  && (name === suffix || [".", "-", "_", "/"].some((separator) => name.endsWith(`${separator}${suffix}`)));

export function calls(trajectory, suffix) {
  const events = trajectory.events ?? [];
  return events.filter((event) => event.type === "tool_call"
    && (!suffix || matchesTool(event.data?.toolName, suffix))).map((event) => {
    const result = events.find((candidate) => candidate.type === "tool_result"
      && candidate.data?.toolCallId === event.data?.toolCallId);
    return { event, args: event.data?.arguments, result: result?.data?.result, success: result?.data?.success === true };
  });
}

export function score(name, checks) {
  if (!checks.length) throw new Error("A grader must contain assertions.");
  const failures = checks.filter((item) => !item.passed);
  return {
    name, kind: "code", passed: failures.length === 0,
    score: (checks.length - failures.length) / checks.length,
    evidence: failures.length ? failures.map((item) => item.label).join("; ") : "All contract assertions passed.",
  };
}

export async function runGrade(name, evaluate) {
  try {
    if (!process.env.EVALUATE_GRADER_INPUT || !process.env.EVALUATE_WORKSPACE) {
      throw new Error("Vally's grader input and workspace are required.");
    }
    const input = JSON.parse(readFileSync(process.env.EVALUATE_GRADER_INPUT, "utf8"));
    if (!input.trajectory || typeof input.trajectory.output !== "string" || !Array.isArray(input.trajectory.events)) {
      throw new Error("A recorded trajectory with output and events is required.");
    }
    const checks = await evaluate(input.trajectory, process.env.EVALUATE_WORKSPACE);
    console.log(JSON.stringify(score(name, checks)));
  } catch (error) {
    console.log(JSON.stringify({
      name, kind: "code", status: "error", passed: false, score: 0,
      evidence: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  }
}
