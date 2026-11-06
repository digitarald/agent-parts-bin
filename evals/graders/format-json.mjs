import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { calls, check, isMain, matchesTool, normalize, runGrade } from "./common.mjs";

// `indent` must match the --indent argument in the plugin's hooks.json (2 by default).
export function assessFormatting(trajectory, workspace, scenario, indent = 2) {
  if (!["format", "invalid"].includes(scenario)) throw new Error(`Unknown formatter scenario: ${scenario}`);
  if (!Number.isInteger(indent) || indent < 1 || indent > 10) throw new Error("Expected an indent from 1 to 10.");
  const compact = scenario === "format" ? '{"enabled":true,"count":2}' : '{"enabled":}';
  const expected = scenario === "format" ? `${JSON.stringify(JSON.parse(compact), null, indent)}\n` : `${compact}\n`;
  const edits = calls(trajectory).filter((call) => call.success
    && ["apply_patch", "create", "edit", "create_file", "replace_string_in_file", "multi_replace_string_in_file"].some((name) => matchesTool(call.event.data.toolName, name)));
  const patchKind = (call) => {
    if (!matchesTool(call.event.data.toolName, "apply_patch")) return false;
    const patch = typeof call.args === "string" ? call.args : call.args?.input ?? call.args?.patch;
    if (typeof patch !== "string") return false;
    const lines = normalize(patch).split("\n");
    const targets = lines.filter((line) => /^\*\*\* (?:Add|Update|Delete|Move to)/.test(line));
    const additions = lines.filter((line) => line.startsWith("+"));
    if (targets.length !== 1 || !/(?:[/\\:]| )input\.json$/.test(targets[0])) return undefined;
    if (targets[0].startsWith("*** Delete File:") && additions.length === 0) return "delete";
    return additions.length === 1 && additions[0] === `+${compact}` ? "compact" : undefined;
  };
  const compactEdits = edits.filter((call) => patchKind(call) === "compact");
  const file = resolve(workspace, "input.json");
  const contents = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const unsafe = calls(trajectory).some((call) =>
    ["bash", "powershell", "shell", "task"].some((name) => matchesTool(call.event.data.toolName, name)));
  const checks = [
    check("The agent must make a real, compact apply_patch edit of input.json.", compactEdits.length > 0),
    check("The agent must not format the file itself or edit other files.", edits.every((call) => patchKind(call))),
    check("The agent must not invoke shell commands or delegate the edit.", !unsafe),
    check(scenario === "format" ? `The hook must produce ${indent}-space JSON with a final LF.` : "Invalid JSON must remain unchanged.",
      scenario === "format" ? contents === expected : typeof contents === "string" && normalize(contents) === expected),
  ];
  const hookEvidence = compactEdits.map((call) => JSON.stringify(call.result)).join("\n");
  if (scenario === "format") {
    checks.push(check("The actual edit response must confirm the formatter hook ran.", /format-json: Formatted/.test(hookEvidence)));
  }
  if (scenario === "invalid") {
    checks.push(check("The actual edit response must include the formatter diagnostic.", /format-json:/i.test(hookEvidence)));
    checks.push(check("The reply must acknowledge the invalid JSON without claiming a repair.", /invalid|malformed|parse|syntax|unexpected/i.test(trajectory.output)));
  }
  return checks;
}

if (isMain(import.meta.url)) {
  await runGrade("formatter-integration", (trajectory, workspace) => assessFormatting(trajectory, workspace, process.argv[2], Number(process.argv[3] ?? 2)));
}
