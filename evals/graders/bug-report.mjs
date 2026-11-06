import { check, isMain, normalize, runGrade } from "./common.mjs";

const headings = ["Summary", "Steps to reproduce", "Expected behavior", "Actual behavior", "Environment"];

export function assessReport(trajectory, scenario) {
  const text = normalize(trajectory.output);
  const plain = text.replaceAll("**", "").replaceAll("`", "");
  if (scenario === "clarify") {
    return [
      check("Must identify missing reproduction steps.", /reproduc|steps|sequence of actions/i.test(plain)),
      check("Must ask at most one focused question, or state the non-interactive blocker.", (text.match(/\?/g) ?? []).length <= 1),
      check("Must stop before drafting a report.", !/^#{1,6}\s+(Summary|Steps to reproduce|Expected behavior|Actual behavior|Environment)\s*$/im.test(text)),
      check("Must not replace required missing details with Not provided.", !/Not provided\./i.test(text)),
    ];
  }
  if (!["ui", "cli", "redact"].includes(scenario)) throw new Error(`Unknown bug-report scenario: ${scenario}`);
  const found = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1]);
  const checks = [
    check("Must use exactly the selected template's headings.", JSON.stringify(found) === JSON.stringify(headings)),
    check("Reproduction steps must be numbered.", /^\s*1\.\s+/m.test(text)),
    check("Missing optional environment details must remain Not provided.", (plain.match(/Not provided\./g) ?? []).length >= 2),
  ];
  if (scenario === "ui") {
    checks.push(check("Must preserve Settings, Theme, Dark, Light, and reload behavior.",
      ["Settings", "Theme", "Dark", "Light"].every((value) => plain.includes(value)) && /reload/i.test(plain)));
  } else if (scenario === "cli") {
    checks.push(
      check("Must preserve the exact command.", plain.includes("acme sync --dry-run")),
      check("Must preserve the observed output.", plain.includes("created cache.db")),
      check("Must preserve exit code 0.", /^Exit code:\s*0\s*$/im.test(plain)),
    );
  } else {
    checks.push(
      check("The example credential must be removed everywhere.", !text.includes("EXAMPLE_SECRET_DO_NOT_USE")),
      check("The meaningful command must remain.", plain.includes("acme fetch") && plain.includes("--dry-run")),
      check("The error and exit code must remain.", plain.includes("authentication failed") && /^Exit code:\s*23\s*$/im.test(plain)),
    );
  }
  return checks;
}

if (isMain(import.meta.url)) {
  await runGrade("bug-report-contract", (trajectory) => assessReport(trajectory, process.argv[2]));
}
