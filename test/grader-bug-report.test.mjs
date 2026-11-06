import test from "node:test";
import assert from "node:assert/strict";
import { missing } from "../scripts/examples.mjs";

const skip = missing("evals/graders/bug-report.mjs");
const { assessReport } = skip ? {} : await import("../evals/graders/bug-report.mjs");
const passes = (checks) => checks.every((item) => item.passed);
const trajectory = (output = "", events = []) => ({ output, events });
const ui = `## Summary
Theme resets from Dark to Light.
## Steps to reproduce
1. Open Settings.
2. Switch Theme to Dark and reload.
## Expected behavior
Dark stays selected.
## Actual behavior
Theme resets to Light.
## Environment
- App version: Not provided.
- OS / browser: Not provided.
`;
const cli = `## Summary
Dry run creates a file.
## Steps to reproduce
1. In an empty folder run \`acme sync --dry-run\`.
## Expected behavior
No files change.
## Actual behavior
created cache.db
Exit code: 0
## Environment
- Tool version: Not provided.
- OS / shell: Not provided.
`;

test("report graders accept faithful templates and reject missing facts or headings", { skip }, () => {
  assert.ok(passes(assessReport(trajectory(ui), "ui")));
  assert.ok(passes(assessReport(trajectory(cli), "cli")));
  assert.ok(!passes(assessReport(trajectory(ui.replaceAll("Dark", "Blue")), "ui")));
  assert.ok(!passes(assessReport(trajectory(ui.replace("## Environment", "## Diagnosis")), "ui")));
  assert.ok(!passes(assessReport(trajectory(cli.replace("Exit code: 0", "Exit code: 1")), "cli")));
});

test("clarification stops drafting and example credentials must be removed", { skip }, () => {
  assert.ok(passes(assessReport(trajectory("What steps reproduce the problem?"), "clarify")));
  assert.ok(!passes(assessReport(trajectory(ui), "clarify")));
  assert.ok(!passes(assessReport(trajectory("What steps reproduce it? Which OS?"), "clarify")));
  const redacted = cli.replace("acme sync --dry-run", "acme fetch --token [REDACTED] --dry-run")
    .replace("created cache.db", "authentication failed for [REDACTED]").replace("Exit code: 0", "Exit code: 23");
  assert.ok(passes(assessReport(trajectory(redacted), "redact")));
  assert.ok(!passes(assessReport(trajectory(redacted.replaceAll("[REDACTED]", "EXAMPLE_SECRET_DO_NOT_USE")), "redact")));
});
