import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectContext, discoverAndFilterEvals } from "@microsoft/vally";
import { resolveBackendSettings } from "../../node_modules/@microsoft/vally-cli/dist/backend-selection.js";
import { parse } from "yaml";
import { powerShellSkip } from "./test-shells.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

function assertReviewerCoverage(projectRoot, evals) {
  if (existsSync(resolve(projectRoot, "plugins/marketplace-maintainer"))) {
    assert.ok(evals.some(({ spec }) => spec.name === "plugin-reviewer-independent"),
      "retained marketplace-maintainer requires its independent reviewer eval");
  }
}

function assertBackendInheritance(command) {
  assert.doesNotMatch(command, /--(?:backend(?:-args)?|in-place)\b/);
}

function assertDocumentedEval(projectRoot, path) {
  if (path === "evals/<plugin>/eval.yaml") return;
  assert.match(path, /^evals\/[a-zA-Z0-9._/-]+\.yaml$/);
  assert.ok(!path.split("/").includes(".."), "Documented eval path must stay in the checkout");
  if (existsSync(resolve(projectRoot, "plugins")) || existsSync(resolve(projectRoot, "evals"))) {
    assert.ok(existsSync(resolve(projectRoot, path)), `Documented eval must exist: ${path}`);
  }
}

test("project root fields match the checked Evals readers and inherit native local execution", async () => {
  // Root-key contract for marketplace-pinned Evals 0.24.6 (copilot-evals-v0.24.6).
  const projectKeys = new Set(["environments", "params", "metadata", "paths", "suites"]);
  const configuration = parse(readFileSync(resolve(root, ".vally.yaml"), "utf8"));
  for (const key of Object.keys(configuration)) {
    assert.ok(projectKeys.has(key), `Unsupported Evals project root field: ${key}`);
  }
  const project = await ProjectContext.load(root);
  const suite = project.resolveSuite("full");
  const discovery = await discoverAndFilterEvals(project, { suiteEvals: suite.evals });
  assert.deepEqual(discovery.errors, []);
  assertReviewerCoverage(root, discovery.matched);
  for (const { filePath, spec } of discovery.matched) {
    const settings = resolveBackendSettings({
      evalBackend: spec.defaults?.backend,
      projectBackend: project.config.defaults?.backend,
      projectDir: project.dir,
      evalDir: dirname(filePath),
      cliCwd: root,
    });
    assert.equal(settings.name, "local", filePath);
    assert.deepEqual(settings.args, {}, filePath);
  }
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assertBackendInheritance(pkg.scripts.eval);
  assertBackendInheritance(pkg.scripts["eval:models"]);
  const workflow = parse(readFileSync(resolve(root, ".github/workflows/evals.yml"), "utf8"));
  assert.equal(workflow.jobs.evals.env.COPILOT_CLI_PATH,
    "${{ github.workspace }}/node_modules/@github/copilot/npm-loader.js");
  assert.doesNotMatch(JSON.stringify(workflow), /docker|compose|--backend/);
  const launches = workflow.jobs.evals.steps.filter((step) => /npm run eval --/.test(step.run ?? ""));
  assert.equal(launches.length, 1);
  assertBackendInheritance(launches[0].run);
});

test("reviewer coverage permits plugin removal but rejects a missing retained reviewer eval", (t) => {
  const directory = resolve(root, ".vally", `reviewer-coverage-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assertReviewerCoverage(directory, []);
  mkdirSync(resolve(directory, "plugins/marketplace-maintainer"), { recursive: true });
  assert.throws(() => assertReviewerCoverage(directory, []), /requires its independent reviewer eval/);
  assertReviewerCoverage(directory, [{ spec: { name: "plugin-reviewer-independent" } }]);
});

test("shared launchers reject backend and in-place overrides in either argument form", () => {
  for (const command of ["vally eval --workers 1", "npm run eval -- --suite smoke --require-pass"]) {
    assertBackendInheritance(command);
    for (const option of [
      "--backend local", "--backend=local", "--backend docker", "--backend=docker",
      "--backend-args grade-network=default", "--backend-args=grade-network=default",
      "--in-place", "--in-place=true",
    ]) {
      assert.throws(() => assertBackendInheritance(`${command} ${option}`), assert.AssertionError);
    }
  }
});

test("documented eval checks permit removed local trees but reject missing retained specs", (t) => {
  const directory = resolve(root, ".vally", `documented-eval-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = "evals/example/eval.yaml";
  assertDocumentedEval(directory, "evals/<plugin>/eval.yaml");
  assertDocumentedEval(directory, path);
  assert.throws(() => assertDocumentedEval(directory, "evals/../outside.yaml"), /stay in the checkout/);
  mkdirSync(resolve(directory, "plugins"));
  assert.throws(() => assertDocumentedEval(directory, path), /must exist/);
  mkdirSync(resolve(directory, "evals/example"), { recursive: true });
  writeFileSync(resolve(directory, path), "synthetic");
  assertDocumentedEval(directory, path);
  rmSync(resolve(directory, "plugins"), { recursive: true });
  assert.throws(() => assertDocumentedEval(directory, "evals/example/missing.yaml"), /must exist/);
});

test("documented credential recipes expose only the selected token and restore ambient values on failure", async (t) => {
  const guide = readFileSync(resolve(root, "docs/checks-and-evals.md"), "utf8");
  const section = guide.slice(guide.indexOf("### Execution and authentication"));
  const bash = section.match(/```sh\n([\s\S]*?)\n```/)[1];
  const powershell = section.match(/```powershell\n([\s\S]*?)\n```/)[1];
  const expectedBash = String.raw`(
  unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
  read -r -s -p "Copilot Requests-only token: " COPILOT_GITHUB_TOKEN || exit
  printf '\n'
  test -n "$COPILOT_GITHUB_TOKEN" || exit 1
  export COPILOT_GITHUB_TOKEN
  npm run eval -- --eval-spec evals/synthetic/eval.yaml --max-retries 0
)`;
  const expectedPowerShell = String.raw`$names = 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'
$original = @{}
foreach ($name in $names) {
  $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
  }
  $secret = Read-Host 'Copilot Requests-only token' -AsSecureString
  $token = [System.Net.NetworkCredential]::new('', $secret).Password
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'No dedicated Copilot credential was supplied.'
  }
  $env:COPILOT_GITHUB_TOKEN = $token
  npm run eval -- --eval-spec evals/synthetic/eval.yaml --max-retries 0
  if ($LASTEXITCODE -ne 0) { throw "Eval exited with code $LASTEXITCODE; inspect its saved results." }
} finally {
  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
  }
  $token = $null
  $secret = $null
}`;
  const normalizeSpec = (script) => script.replace(/--eval-spec (?:"evals\/[^"\n]+\.yaml"|evals\/[a-zA-Z0-9._/-]+\.yaml)/g, "--eval-spec <eval>");
  for (const script of [bash, powershell]) {
    const specs = [...script.matchAll(/--eval-spec (\S+)/g)];
    assert.equal(specs.length, 1, "the credential recipe must select one explicit eval");
    const path = specs[0][1].replace(/^"|"$/g, "");
    assertDocumentedEval(root, path);
  }
  assert.equal(normalizeSpec(bash), normalizeSpec(expectedBash));
  assert.equal(normalizeSpec(powershell), normalizeSpec(expectedPowerShell));
  const paid = guide.slice(guide.indexOf("## Paid evals"));
  assert.equal(normalizeSpec(paid.match(/```sh\n([\s\S]*?)\n```/)[1]), normalizeSpec(expectedBash),
    "the first paid run example must include scoped authentication");
  assert.ok(paid.indexOf("### Execution and authentication") < paid.indexOf("```sh"));
  const env = { ...process.env, COPILOT_GITHUB_TOKEN: "synthetic-copilot", GH_TOKEN: "synthetic-gh", GITHUB_TOKEN: "synthetic-github" };
  for (const exit of [0, 37]) {
    const sh = spawnSync("bash", ["-c", `
npm() { [[ "$(printenv COPILOT_GITHUB_TOKEN)" == synthetic-selected && -z "\${GH_TOKEN+x}\${GITHUB_TOKEN+x}" ]] || return 92; return ${exit}; }
${expectedBash}
result=$?
[[ $result == ${exit} && "$COPILOT_GITHUB_TOKEN" == synthetic-copilot && "$GH_TOKEN" == synthetic-gh && "$GITHUB_TOKEN" == synthetic-github ]]
`], { env, input: "synthetic-selected\n", encoding: "utf8", timeout: 10000 });
    assert.ifError(sh.error);
    assert.equal(sh.status, 0, sh.stderr);
    if (exit === 0) {
      const noExport = spawnSync("bash", ["-c", `
npm() { [[ "$(printenv COPILOT_GITHUB_TOKEN)" == synthetic-selected ]] || return 92; }
${expectedBash.replace("  export COPILOT_GITHUB_TOKEN\n", "")}
`], { env, input: "synthetic-selected\n", encoding: "utf8", timeout: 10000 });
      assert.ifError(noExport.error);
      assert.equal(noExport.status, 92, "missing export must be detected in a child process");
    }
    await t.test(`PowerShell restores credentials after exit ${exit}`, { skip: powerShellSkip }, () => {
    const ps = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if ($env:COPILOT_GITHUB_TOKEN -or $env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Credential lookup was not isolated' }
  ConvertTo-SecureString 'synthetic-selected' -AsPlainText -Force
}
function npm {
  if ($env:COPILOT_GITHUB_TOKEN -ne 'synthetic-selected' -or $env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Unexpected task credential' }
  $global:LASTEXITCODE = ${exit}
}
$caught = $false
try {
${expectedPowerShell}
} catch { $caught = $true }
if ($caught -ne $${exit !== 0} -or $env:COPILOT_GITHUB_TOKEN -ne 'synthetic-copilot' -or $env:GH_TOKEN -ne 'synthetic-gh' -or $env:GITHUB_TOKEN -ne 'synthetic-github') { throw 'Recipe did not restore original credentials' }
exit 0
`], { env, encoding: "utf8", timeout: 60000 });
    assert.ifError(ps.error);
    assert.equal(ps.status, 0, ps.stderr);
    });
  }
  for (const input of ["", "\n"]) {
    const empty = spawnSync("bash", ["-c", `
npm() { return 93; }
${expectedBash}
result=$?
[[ $result == 1 && "$COPILOT_GITHUB_TOKEN" == synthetic-copilot && "$GH_TOKEN" == synthetic-gh && "$GITHUB_TOKEN" == synthetic-github ]]
`], { env, input, encoding: "utf8", timeout: 10000 });
    assert.ifError(empty.error);
    assert.equal(empty.status, 0, empty.stderr);
  }
  await t.test("PowerShell rejects empty credentials", { skip: powerShellSkip }, () => {
  const empty = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
$global:ran = $false
function Read-Host { [Security.SecureString]::new() }
function npm { $global:ran = $true }
$caught = $false
try {
${expectedPowerShell}
} catch { $caught = $true }
if (-not $caught -or $ran -or $env:COPILOT_GITHUB_TOKEN -ne 'synthetic-copilot' -or $env:GH_TOKEN -ne 'synthetic-gh' -or $env:GITHUB_TOKEN -ne 'synthetic-github') { throw 'Empty input did not fail closed and restore original credentials' }
exit 0
`], { env, encoding: "utf8", timeout: 60000 });
  assert.ifError(empty.error);
  assert.equal(empty.status, 0, empty.stderr);
  });
});
