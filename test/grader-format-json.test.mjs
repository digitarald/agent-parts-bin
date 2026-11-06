import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missing } from "../scripts/examples.mjs";

const skip = missing("evals/graders/format-json.mjs");
const { assessFormatting } = skip ? {} : await import("../evals/graders/format-json.mjs");
const passes = (checks) => checks.every((item) => item.passed);
const trajectory = (output = "", events = []) => ({ output, events });

let nextId = 0;
function tool(name, args, value, turn = 0, success = true) {
  const toolCallId = `call-${nextId++}`;
  return [
    { type: "tool_call", turn, data: { toolName: name, toolCallId, arguments: args } },
    { type: "tool_result", turn, data: { toolName: name, toolCallId, success, result: typeof value === "string"
      ? { content: value } : { structuredContent: value, content: JSON.stringify(value) } } },
  ];
}

test("formatter grader requires a compact agent edit, an actual hook receipt, and formatted bytes", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "starter-format-grade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "input.json"), '{\n  "enabled": true,\n  "count": 2\n}\n');
  const patch = "*** Begin Patch\n*** Update File: input.json\n@@\n-{}\n+{\"enabled\":true,\"count\":2}\n*** End Patch\n";
  const receipt = "Tool succeeded. format-json: Formatted input.json. Re-read it before further edits.";
  const compact = tool("apply_patch", patch, receipt);
  assert.ok(passes(assessFormatting(trajectory("", compact), dir, "format")));
  assert.ok(passes(assessFormatting(trajectory("", [
    ...tool("apply_patch", "*** Begin Patch\n*** Delete File: input.json\n*** End Patch\n", "Deleted."),
    ...compact,
  ]), dir, "format")));
  assert.ok(!passes(assessFormatting(trajectory("", tool("apply_patch", patch, "Edited.")), dir, "format")));
  assert.ok(!passes(assessFormatting(trajectory("", [
    ...compact, ...tool("apply_patch", "*** Begin Patch\n*** Add File: other.txt\n+extra\n*** End Patch", "Added."),
  ]), dir, "format")));
  const manual = patch.replace('+{"enabled":true,"count":2}', '+{\n+  "enabled": true,\n+  "count": 2\n+}');
  assert.ok(!passes(assessFormatting(trajectory("", tool("apply_patch", manual, receipt)), dir, "format")));
  // A different configured indentation expects different bytes.
  assert.ok(!passes(assessFormatting(trajectory("", compact), dir, "format", 4)));
  writeFileSync(join(dir, "input.json"), '{\n    "enabled": true,\n    "count": 2\n}\n');
  assert.ok(passes(assessFormatting(trajectory("", compact), dir, "format", 4)));
  assert.throws(() => assessFormatting(trajectory("", compact), dir, "format", 0), /indent/);
});

test("formatter invalid-input grade rejects silent repairs and missing diagnostics", { skip }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "starter-invalid-grade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const patch = "*** Begin Patch\n*** Update File: input.json\n@@\n-{}\n+{\"enabled\":}\n*** End Patch\n";
  const result = trajectory("The JSON is invalid and was left unchanged.", tool("apply_patch", patch, "format-json: input.json: invalid JSON"));
  writeFileSync(join(dir, "input.json"), '{"enabled":}\n');
  assert.ok(passes(assessFormatting(result, dir, "invalid")));
  writeFileSync(join(dir, "input.json"), '{"enabled":null}\n');
  assert.ok(!passes(assessFormatting(result, dir, "invalid")));
});
