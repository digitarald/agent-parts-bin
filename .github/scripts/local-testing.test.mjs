import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDefaultGraderRegistry, gradeInDisposableWorkspace } from "@microsoft/vally";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));
const guidanceTest = existsSync(resolve(root, "plugins/plugin-authoring")) ? test : test.skip;
const skillEvals = [
  ["plugin-authoring", ["add-plugin", "try-plugin-locally", "submit-plugin"]],
  ["marketplace-maintainer", ["update-remote-pins", "release-plugins"]],
].filter(([plugin]) => existsSync(resolve(root, "plugins", plugin))).flatMap(([plugin, skills]) => skills.map((skill) => ({
  skill, skills,
  spec: parse(readFileSync(resolve(root, "evals", plugin, "skills", skill, "eval.yaml"), "utf8")),
})));
const invocationTest = skillEvals.length ? test : test.skip;

async function fixture(t) {
  const directory = resolve(root, ".github/scripts", `.local-test-${randomUUID()} space`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(resolve(root, "evals/_shared/fixtures/sample-marketplace"), directory, { recursive: true });
  copyFileSync(resolve(root, "evals/plugin-authoring/skills/try-plugin-locally/grader.mjs"), resolve(directory, "grader.mjs"));
  copyFileSync(resolve(root, "evals/_shared/graders/common.mjs"), resolve(directory, "common.mjs"));
  const { evaluate } = await import(pathToFileURL(resolve(directory, "grader.mjs")));
  const { score } = await import(pathToFileURL(resolve(directory, "common.mjs")));
  const selected = resolve(directory, "plugins/sample-notes");
  const output = (path = selected) => [
    "Review the local plugin source and accept host trust and tool permissions before starting a fresh Copilot CLI session.",
    "```sh", `copilot --plugin-dir "${path}"`, "```",
    "Session: not started", "Discovery: unverified", "Behavior: unverified",
  ].join("\n");
  const grade = (text = output(), commands = [], toolCalls = [], results = [], extraEvents = []) => score("local-guidance", evaluate({
    output: text,
    events: [...[...commands.map((command) => ({ toolName: "powershell", arguments: { command } })), ...toolCalls].map((call, index) => ({
      type: "tool_call", data: { toolCallId: String(index), ...call },
    })), ...results, ...extraEvents],
  }, directory));
  return { directory, selected, output, grade };
}

guidanceTest("local guidance accepts the selected absolute checkout path with spaces without running Copilot", async (t) => {
  const { output, grade, selected } = await fixture(t);
  for (const path of [selected, selected.replaceAll("\\", "/")]) {
    assert.equal(grade(output(path)).passed, true);
  }
  assert.equal(grade(output(), [`Write-Output 'copilot --plugin-dir "${selected}"'`]).passed, true,
    "echoing a prepared command is allowed without claiming host verification");
  assert.equal(grade(`${output()}\nRun it using --plugin-dir with your absolute path: \`copilot --plugin-dir "${selected}"\`.`).passed, true,
    "unquoted prose words after --plugin-dir and repeated identical operands must pass");
  if (process.platform === "win32") assert.equal(grade(output(selected.toLowerCase())).passed, true);
});

guidanceTest("local guidance checks the original agent path when Vally grades a workspace copy", async (t) => {
  const { directory, output, grade } = await fixture(t);
  const original = resolve(directory, "original trial");
  const selected = resolve(original, "plugins/sample-notes");
  const activation = [{ type: "skill_activation", data: {
    name: "try-plugin-locally", path: resolve(original, "try-plugin-locally/SKILL.md"),
  } }];
  assert.equal(grade(output(selected), [], [], [], activation).passed, true);
  for (const wrong of [resolve(directory, "plugins/sample-notes"), resolve(original, "installed/sample-notes"), "./plugins/sample-notes"]) {
    assert.equal(grade(output(wrong), [], [], [], activation).passed, false, wrong);
  }
  assert.equal(grade(output(selected)).passed, false, "an answer cannot declare its own original workspace");
});

guidanceTest("local guidance accepts explicit tool-use approval without dropping the permission requirement", async (t) => {
  const { output, grade } = await fixture(t);
  const approved = output().replace("host trust and tool permissions", "host trust and approve tool use");
  assert.equal(grade(approved).passed, true);
  assert.equal(grade(approved.replace(" and approve tool use", "")).passed, false);
});

guidanceTest("native disposable grading preserves the selected agent-workspace identity", async (t) => {
  const { directory, output } = await fixture(t);
  const grader = createDefaultGraderRegistry().get("program");
  const result = await gradeInDisposableWorkspace({
    trajectory: {
      output: output(),
      workDir: directory,
      events: [{ type: "skill_activation", data: {
        name: "try-plugin-locally", path: resolve(directory, "try-plugin-locally/SKILL.md"),
      } }],
    },
    graderFiles: [
      { src: resolve(directory, "grader.mjs"), dest: ".grading/grader.mjs" },
      { src: resolve(directory, "common.mjs"), dest: ".grading/common.mjs" },
    ],
    grade: async (trajectory) => {
      assert.notEqual(trajectory.workDir, directory);
      return grader.grade({ trajectory, config: { program: process.execPath, args: [".grading/grader.mjs"] } });
    },
  });
  assert.equal(result.passed, true, result.evidence);
});

guidanceTest("local guidance rejects relative, wrong, installed, and published plugin sources", async (t) => {
  const { directory, output, grade } = await fixture(t);
  for (const path of [
    "./plugins/sample-notes", directory, resolve(directory, "plugins/other"),
    resolve(directory, "installed/sample-notes"), "sample-notes@fixture-plugins",
    "https://github.com/example/marketplace",
  ]) {
    const result = grade(output(path));
    assert.equal(result.passed, false, path);
    assert.match(result.evidence, /selected absolute local session command/);
  }
  const additional = output().replace('"\n```', `" --plugin-dir "${resolve(directory, "installed/sample-notes")}"\n` + "```");
  assert.equal(grade(additional).passed, false, "an extra source must not hide behind a correct local path");
});

guidanceTest("local guidance rejects attempted install, uninstall, profile, session, and branch mutations even without a successful tool result", async (t) => {
  const { output, grade, selected } = await fixture(t);
  for (const command of [
    "copilot plugin install sample-notes@fixture-plugins",
    "copilot plugin install $spec",
    "copilot plugin uninstall $spec",
    "copilot plugin marketplace add .",
    `copilot --plugin-dir "${selected}"`,
    "copilot", "copilot -p 'Try the plugin'",
    '& "C:\\trusted path\\copilot.exe" --plugin-dir "C:\\plugin"',
    'node "node_modules/@github/copilot/npm-loader.js" --plugin-dir .',
    "$env:COPILOT_HOME = 'new-profile'",
    "git switch candidate", "git -C . switch candidate", "git checkout candidate", "git stash", "git reset --hard",
    'git -C "C:\\checkout\\project" checkout candidate', 'git -c advice.detachedHead=false checkout candidate',
  ]) {
    const result = grade(output(), [command]);
    assert.equal(result.passed, false, command);
    assert.match(result.evidence, /Did not launch Copilot/);
  }
  for (const command of ["copilot plugin install $spec", "git checkout candidate"]) {
    assert.equal(grade(output(), [command], [], [{
      type: "tool_result", data: { toolCallId: "0", success: false, result: "Permission denied; command not run." },
    }]).passed, false, "denied attempts still violate preparation-only instructions");
  }
  assert.equal(grade(output().replace("Session: not started", "```sh\ncopilot plugin install $spec\n```\nSession: not started")).passed, false);
});

guidanceTest("local guidance ignores read-only and descriptive arguments but still checks shell commands", async (t) => {
  const { output, grade, selected } = await fixture(t);
  for (const call of [
    { toolName: "grep", arguments: { pattern: "copilot --plugin-dir" } },
    { toolName: "report_intent", arguments: { intent: "Copilot command preparation" } },
    { toolName: "report_intent", arguments: { intent: "Checking git state without checkout" } },
    { toolName: "functions.powershell", arguments: { command: "git status --short", description: "Checking git state without checkout" } },
    { toolName: "powershell", arguments: { command: "Write-Output 'Do not use git checkout; keep your changes.'" } },
    { toolName: "bash", arguments: { command: "echo 'Do not use git checkout; keep your changes.'" } },
    { toolName: "powershell", arguments: { command: 'git -C "C:\\checkout\\project" status --short' } },
  ]) {
    assert.equal(grade(output(), [], [call]).passed, true, JSON.stringify(call));
  }
  for (const toolName of ["bash", "powershell", "shell", "functions.powershell", "functions.bash"]) {
    for (const command of [`copilot --plugin-dir "${selected}"`, "git checkout candidate"]) {
      assert.equal(grade(output(), [], [{ toolName, arguments: { command } }]).passed, false, `${toolName}: ${command}`);
    }
  }
});

guidanceTest("local guidance grades long Git option lists within a bounded process", async (t) => {
  const { directory, output } = await fixture(t);
  const input = resolve(directory, "grader-input.json");
  for (const prefix of [
    `git ${"-c ! ".repeat(2048)}`,
    `git -c ${'"" -c '.repeat(2048)}! `,
    `git ${"--git-dir --work-tree ".repeat(2048)}`,
  ]) {
    for (const [command, passed] of [["status --short", true], ["checkout candidate", false]]) {
      writeFileSync(input, JSON.stringify({ trajectory: {
        output: output(),
        events: [{ type: "tool_call", data: {
          toolCallId: "long-options", toolName: "powershell", arguments: { command: prefix + command },
        } }],
      } }));
      const result = spawnSync(process.execPath, [resolve(directory, "grader.mjs")], {
        cwd: directory, encoding: "utf8", timeout: 5000,
        env: { ...process.env, EVALUATE_GRADER_INPUT: input, EVALUATE_WORKSPACE: directory },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).passed, passed, command);
    }
  }
});

invocationTest("every skill eval case keeps a strict native required or disallowed invocation check", () => {
  for (const { skill, skills, spec } of skillEvals) {
    assert.equal(spec.scoring.threshold, 1, skill);
    for (const stimulus of spec.stimuli) {
      const invocation = stimulus.graders.filter((grader) => grader.type === "skill-invocation");
      assert.equal(invocation.length, 1, stimulus.name);
      assert.deepEqual(invocation[0].config, stimulus.tags?.control === "negative"
        ? { disallowed: skills } : { required: [skill] }, stimulus.name);
    }
  }
});

invocationTest("native skill grader requires exact activation in every positive and boundary case", async () => {
  const grader = createDefaultGraderRegistry().get("skill-invocation");
  assert.ok(grader);
  for (const { skill, spec } of skillEvals) {
    const reads = [
      `C:\\skills\\${skill}\\SKILL.md`,
      `/skills/${skill}/references/guide.md`,
    ].flatMap((path, index) => [
      { type: "tool_call", data: { toolCallId: `read-${index}`, toolName: "view", arguments: { path } } },
      { type: "tool_result", data: { toolCallId: `read-${index}`, success: true, result: "Skill contents" } },
    ]);
    const search = [
      { type: "tool_call", data: { toolCallId: "search", toolName: "grep", arguments: { pattern: `/skills/${skill}/SKILL.md` } } },
      { type: "tool_result", data: { toolCallId: "search", success: true, result: "Found skill path" } },
    ];
    for (const stimulus of spec.stimuli.filter((item) => item.tags?.control !== "negative")) {
      const config = stimulus.graders.find((item) => item.type === "skill-invocation").config;
      for (const [label, events, passed] of [
        ["matching activation", [{ type: "skill_activation", data: { name: skill } }], true],
        ["no activation", [], false],
        ["wrong activation", [{ type: "skill_activation", data: { name: `${skill}-other` } }], false],
        ["successful file reads", reads, false],
        ["successful search", search, false],
      ]) {
        const result = await grader.grade({
          stimulus, config,
          trajectory: { output: `Completed using ${skill}; see /skills/${skill}/SKILL.md.`, endReason: "completed", events },
        });
        assert.equal(result.passed, passed, `${stimulus.name}: ${label}`);
        assert.equal(result.score, passed ? 1 : 0, `${stimulus.name}: ${label}`);
      }
    }
  }
});

invocationTest("native skill grader passes no activation and rejects every forbidden skill in negative cases", async () => {
  const grader = createDefaultGraderRegistry().get("skill-invocation");
  assert.ok(grader);
  for (const { spec } of skillEvals) {
    for (const stimulus of spec.stimuli.filter((item) => item.tags?.control === "negative")) {
      const config = stimulus.graders.find((item) => item.type === "skill-invocation").config;
      const absent = await grader.grade({ stimulus, config, trajectory: { output: "Done.", events: [] } });
      assert.equal(absent.passed, true, stimulus.name);
      for (const name of config.disallowed) {
        const result = await grader.grade({
          stimulus, config,
          trajectory: { output: "Done.", events: [{ type: "skill_activation", data: { name } }] },
        });
        assert.equal(result.passed, false, `${stimulus.name}: ${name}`);
        assert.equal(result.score, 0, `${stimulus.name}: ${name}`);
      }
    }
  }
});

guidanceTest("local program grader reports outcome checks independently of invocation", async (t) => {
  const { directory, output } = await fixture(t);
  const input = resolve(directory, "grader-input.json");
  writeFileSync(input, JSON.stringify({ trajectory: { output: output(), events: [] } }));
  const result = spawnSync(process.execPath, [resolve(directory, "grader.mjs")], {
    cwd: directory, encoding: "utf8", timeout: 10000,
    env: { ...process.env, EVALUATE_GRADER_INPUT: input, EVALUATE_WORKSPACE: directory },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    name: "plugin-authoring-try", kind: "code", passed: true, score: 1,
    evidence: "All contract assertions passed.",
  });
});

guidanceTest("local guidance doesn't count an echoed command as verified host discovery or behavior", async (t) => {
  const { output, grade, selected } = await fixture(t);
  const fabricated = output().replaceAll("unverified", "verified");
  assert.equal(grade(fabricated, [`Write-Output 'copilot --plugin-dir "${selected}"'`]).passed, false);
  for (const status of ["Session: not started", "Discovery: unverified", "Behavior: unverified"]) {
    const result = grade(output().replace(status, ""));
    assert.equal(result.passed, false);
    assert.match(result.evidence, /honestly unverified/);
  }
  assert.equal(grade(output().replace("trust and tool permissions", "prompts")).passed, false);
});

guidanceTest("local guidance refuses a missing or changed selected local manifest/catalog", async (t) => {
  const { directory, grade } = await fixture(t);
  writeFileSync(resolve(directory, "plugins/sample-notes/plugin.json"), '{"name":"different"}');
  assert.equal(grade().passed, false);
  writeFileSync(resolve(directory, "marketplace.json"), "{}");
  assert.equal(grade().passed, false);
});
