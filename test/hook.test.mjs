import baseTest from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { missing } from "../scripts/examples.mjs";

// Example-only tests: skip every test here when the example's files are gone.
const skip = missing("plugins/format-json/com.github.copilot/hooks/format.mjs");
const test = skip ? (name) => baseTest(name, { skip }) : baseTest;

const hook = fileURLToPath(new URL("../plugins/format-json/com.github.copilot/hooks/format.mjs", import.meta.url));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "marketplace-format-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
const event = (cwd, toolName = "edit", toolArgs = { path: "sample.json" }, resultType = "success") => ({
  cwd, toolName, toolArgs, toolResult: { resultType },
});
function processHook(input, args = []) {
  const result = spawnSync(process.execPath, [hook, ...args], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  assert.ok(Object.keys(output).every((key) => key === "additionalContext"), "No permission or result overrides.");
  return { output, stderr: result.stderr };
}
const before = '{"hello":"world","nested":{"n":1}}';
const after = '{\n  "hello": "world",\n  "nested": {\n    "n": 1\n  }\n}\n';

test("actual hook formats supported single-file tools, including JSON-encoded args", (t) => {
  const cwd = fixture(t);
  const path = join(cwd, "sample.json");
  for (const [name, args] of [
    ["create", { path: "sample.json" }],
    ["edit", { path }],
    ["create_file", { filePath: path }],
    ["replace_string_in_file", { filePath: path }],
    ["edit", JSON.stringify({ path })],
  ]) {
    writeFileSync(path, before);
    const { output, stderr } = processHook(event(cwd, name, args));
    assert.equal(readFileSync(path, "utf8"), after, name);
    assert.ok(output.additionalContext.includes(path), name);
    assert.match(output.additionalContext, /Re-read/);
    assert.equal(stderr, "");
  }
});

test("multi-file edits format only named JSON files and deduplicate paths", (t) => {
  const cwd = fixture(t);
  for (const name of ["one.json", "two.json", "untouched.json", "notes.txt", "settings.jsonc"]) {
    writeFileSync(join(cwd, name), before);
  }
  const args = { replacements: ["one.json", "two.json", "one.json", "notes.txt", "settings.jsonc"].map((filePath) => ({ filePath })) };
  const { output } = processHook(event(cwd, "multi_replace_string_in_file", args));
  assert.equal(readFileSync(join(cwd, "one.json"), "utf8"), after);
  assert.equal(readFileSync(join(cwd, "two.json"), "utf8"), after);
  for (const name of ["untouched.json", "notes.txt", "settings.jsonc"]) {
    assert.equal(readFileSync(join(cwd, name), "utf8"), before);
  }
  assert.equal(output.additionalContext.split("\n").length, 2);
});

test("apply_patch handles raw and object payloads, additions, updates, moves, and deletions", (t) => {
  const cwd = fixture(t);
  const patch = "*** Begin Patch\n*** Add File: added.json\n+{}\n*** Update File: updated.json\n@@\n-{}\n+{}\n*** Update File: old.json\n*** Move to: moved.json\n@@\n-{}\n+{}\n*** Delete File: deleted.json\n*** End Patch";
  for (const args of [patch, { input: patch }, { patch }, JSON.stringify({ input: patch }), JSON.stringify(patch)]) {
    for (const name of ["added.json", "updated.json", "moved.json"]) writeFileSync(join(cwd, name), before);
    const { output, stderr } = processHook(event(cwd, "apply_patch", args));
    assert.equal(stderr, "");
    assert.equal(output.additionalContext.split("\n").length, 3);
    for (const name of ["added.json", "updated.json", "moved.json"]) {
      assert.equal(readFileSync(join(cwd, name), "utf8"), after);
    }
  }
  assert.deepEqual(processHook(event(cwd, "apply_patch", "*** Begin Patch\n*** Delete File: deleted.json\n*** End Patch")).output, {});
});

test("failed, unknown, non-JSON, and already formatted edits do not write files", (t) => {
  const cwd = fixture(t);
  const path = join(cwd, "sample.json");
  writeFileSync(path, before);
  for (const input of [
    event(cwd, "edit", { path }, "failure"),
    { ...event(cwd), toolResult: undefined },
    event(cwd, "bash", { command: "write sample.json" }),
    event(cwd, "Write", { file_path: path }),
    event(cwd, "edit", { path: "missing.txt" }),
  ]) {
    assert.deepEqual(processHook(input).output, {});
    assert.equal(readFileSync(path, "utf8"), before);
  }
  writeFileSync(path, after);
  utimesSync(path, 1, 1);
  const mtime = lstatSync(path).mtimeMs;
  assert.deepEqual(processHook(event(cwd)).output, {});
  assert.equal(lstatSync(path).mtimeMs, mtime);
});

test("invalid JSON stays unchanged with explicit diagnostics; other files still format", (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, "bad.json"), "{");
  writeFileSync(join(cwd, "sample.json"), before);
  const { output, stderr } = processHook(event(cwd, "multi_replace_string_in_file", {
    replacements: [{ filePath: "bad.json" }, { filePath: "sample.json" }],
  }));
  assert.equal(readFileSync(join(cwd, "bad.json"), "utf8"), "{");
  assert.equal(readFileSync(join(cwd, "sample.json"), "utf8"), after);
  assert.match(stderr, /bad\.json/);
  assert.match(output.additionalContext, /bad\.json/);
  assert.match(output.additionalContext, /Formatted/);
});

test("malformed events, missing files, and outside paths report rather than silently succeed", (t) => {
  const cwd = fixture(t);
  const outside = join(fixture(t), "outside.json");
  writeFileSync(outside, before);
  for (const input of [
    null,
    {},
    { ...event(cwd), cwd: "." },
    event(cwd, "edit", "{"),
    event(cwd, "edit", {}),
    event(cwd, "multi_replace_string_in_file", {}),
    event(cwd, "apply_patch", { input: "invalid" }),
    event(cwd, "edit", { path: "missing.json" }),
    event(cwd, "edit", { path: outside }),
  ]) {
    const { output, stderr } = processHook(input);
    assert.match(output.additionalContext, /format-json:/);
    assert.match(stderr, /format-json:/);
  }
  assert.equal(readFileSync(outside, "utf8"), before);
});

// Windows needs elevation or Developer Mode for a file symlink, so that case
// skips there. A directory junction needs neither, so the escape through a
// linked directory runs everywhere.
test("symbolic links to files are rejected", { skip: process.platform === "win32" && "file symlinks need elevation on Windows" }, (t) => {
  const cwd = fixture(t);
  const outside = fixture(t);
  writeFileSync(join(outside, "sample.json"), before);
  symlinkSync(join(outside, "sample.json"), join(cwd, "sample.json"));
  assert.match(processHook(event(cwd)).output.additionalContext, /symbolic link/);
  assert.equal(readFileSync(join(outside, "sample.json"), "utf8"), before);
});

test("a linked directory cannot redirect formatting outside the working directory", (t) => {
  const cwd = fixture(t);
  const outside = fixture(t);
  writeFileSync(join(outside, "sample.json"), before);
  symlinkSync(outside, join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.match(processHook(event(cwd, "edit", { path: "linked/sample.json" })).output.additionalContext, /outside/);
  assert.equal(readFileSync(join(outside, "sample.json"), "utf8"), before);
});

test("relative paths use event cwd, including paths with spaces", (t) => {
  const root = fixture(t);
  const cwd = join(root, "project with spaces");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "sample.json"), before);
  processHook(event(cwd));
  assert.equal(readFileSync(join(cwd, "sample.json"), "utf8"), after);
});

test("diagnostics never echo the contents of malformed JSON, hook input, or tool arguments", (t) => {
  const cwd = fixture(t);
  const secret = "SYNTHETIC_SECRET_NOT_REAL_123";
  writeFileSync(join(cwd, "bad.json"), `{\n  "token": ${secret}\n}`);
  const { output, stderr } = processHook(event(cwd, "edit", { path: "bad.json" }));
  assert.equal(readFileSync(join(cwd, "bad.json"), "utf8"), `{\n  "token": ${secret}\n}`);
  assert.match(output.additionalContext, /bad\.json: Isn't valid JSON/);
  for (const text of [output.additionalContext, stderr]) assert.doesNotMatch(text, /SYNTHETIC/);
  const args = processHook(event(cwd, "edit", `{"path": ${secret}`));
  assert.match(args.output.additionalContext, /toolArgs: Isn't valid JSON/);
  assert.doesNotMatch(args.output.additionalContext + args.stderr, /SYNTHETIC/);
  const raw = spawnSync(process.execPath, [hook], { input: `{"cwd": ${secret}`, encoding: "utf8", timeout: 10_000 });
  assert.equal(raw.status, 0);
  assert.match(JSON.parse(raw.stdout).additionalContext, /^format-json: Hook input: Isn't valid JSON/);
  assert.doesNotMatch(raw.stdout + raw.stderr, /SYNTHETIC/);
});

test("--indent sets the indentation; bad or unknown arguments are reported, not ignored", (t) => {
  const cwd = fixture(t);
  const path = join(cwd, "sample.json");
  writeFileSync(path, before);
  processHook(event(cwd), ["--indent", "4"]);
  assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(JSON.parse(before), null, 4)}\n`);
  assert.deepEqual(processHook(event(cwd), ["--indent=4"]).output, {}, "Already formatted at four spaces.");
  for (const args of [["--indent", "0"], ["--indent", "11"], ["--indent", "two"], ["--tabs"], ["extra"]]) {
    writeFileSync(path, before);
    const { output } = processHook(event(cwd), args);
    assert.match(output.additionalContext, /^format-json: (--indent must|Unsupported arguments)/, args.join(" "));
    assert.equal(readFileSync(path, "utf8"), before, args.join(" "));
  }
});

test("the packaged hooks.json command and the eval grader agree on the indentation", (t) => {
  const plugin = fileURLToPath(new URL("../plugins/format-json/", import.meta.url));
  const command = JSON.parse(readFileSync(join(plugin, "com.github.copilot/hooks/hooks.json"), "utf8")).hooks.postToolUse[0].command;
  const configured = command.match(/^node "\$\{PLUGIN_ROOT\}\/[^"]+"(.*)$/)[1].trim().split(/\s+/).filter(Boolean);
  const cwd = fixture(t);
  writeFileSync(join(cwd, "sample.json"), before);
  processHook(event(cwd), configured);
  const formatted = readFileSync(join(cwd, "sample.json"), "utf8");
  const spec = parse(readFileSync(fileURLToPath(new URL("../evals/format-json/eval.yaml", import.meta.url)), "utf8"));
  const grader = spec.stimuli.find((stimulus) => stimulus.name === "format-json-runs-after-compact-edit").graders.find((item) => item.type === "program");
  const indent = Number(grader.config.args[2] ?? 2);
  assert.equal(formatted, `${JSON.stringify(JSON.parse(before), null, indent)}\n`,
    "Change the grader's indent argument in evals/format-json/eval.yaml when you change --indent in hooks.json.");
});
