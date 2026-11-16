# Checks and evals

Run these commands from the repository root with
[Node.js and npm](../README.md#requirements).

## Model-free checks

```sh
npm ci
npm run lint
```

The lockfile keeps exact versions and integrity hashes without registry-specific
tarball URLs. Preserve existing SHA-512 integrity values for unchanged package
versions: a registry mirror that omits `dist.integrity` can cause npm to replace
them with weaker SHA-1 values from `dist.shasum` during an upgrade. Removing
`resolved` URLs does not require changing integrity values. After changing
dependencies, preserve that format with npm's
[`omit-lockfile-registry-resolved`](https://docs.npmjs.com/cli/v11/using-npm/config/#omit-lockfile-registry-resolved)
option:

```sh
npm install --package-lock-only --ignore-scripts --omit-lockfile-registry-resolved
```

`npm ci` resolves tarball endpoints through the configured registry. A successful
install through a development mirror does not verify public-registry availability.

`npm run verify` is the publishing gate. It checks types, schemas, catalog
consistency, generated files, and deterministic tests without requiring eval
coverage or lint. The retained tooling now lives in `.github/scripts/`.

`npm run lint` is an optional check of local catalog consistency and every skill under
`plugins/` and every eval under `evals/` with the pinned
[Vally](https://microsoft.github.io/vally/) CLI. A remote-only marketplace can
omit both directories; schema validation also skips when no local manifests
remain. Template-plugin tests skip when their plugins are absent; they are
not evidence about this marketplace's plugins.
None of these checks calls a model. [Validate](../.github/workflows/validate.yml)
runs `verify` on pull requests, pushes to `main`, and manual dispatch, on Linux
with Node.js 24. It:

- Runs deterministic tests for the infrastructure and retained plugins.
- Validates each `plugins/*/plugin.json` against the
  [Agent Plugins schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json).
- Rejects catalog entries without a non-empty local source path or a remote
  source object.
- Checks that each local entry in `marketplace.json` matches its `plugin.json`.
- Checks remote catalog metadata without fetching upstream code.
  The separate `npm run check-remotes` checks that a pin exists and that the
  upstream name and optional version match. A supplied ref must resolve to the
  exact pinned commit. Private repositories need a token that can read them.

Vally lint doesn't validate `marketplace.json` or `plugin.json`. Use:

```sh
node .github/scripts/check-local-catalog.mjs
npm run check
node .github/scripts/check-remote-pins.mjs
```

`npm run check` uses the repository's vendored schemas, offline. The inherited
optional `validate-schema.sh` instead downloads the Agent Plugins schema and runs
`ajv-cli@5.0.0` through `npx --yes`; review that network/tool execution before
running it. The pin check makes read-only GitHub API calls through your
authenticated `gh` CLI. Neither starts a model.

Remote checks prefer a root manifest declaring a supported Agent Plugins schema
(1.0.0 or 1.1.0); unsupported Agent Plugins versions fail. Otherwise they use
Copilot CLI's legacy order: `.plugin/plugin.json`, `plugin.json`,
`.github/plugin/plugin.json`, then `.claude-plugin/plugin.json`.

The CI checks and their tests live in [.github/scripts/](../.github/scripts/).
Run the tests without calling a model:

```sh
node --test .github/scripts/*.test.mjs
```

Credential recipe tests use fake CLI functions and need Bash and PowerShell
(`pwsh`), available in CI. Locally, missing PowerShell is reported as skipped;
CI requires it. See [local development](local-development.md) for the separate
installation checks. Neither check proves how a plugin behaves in a model session.

## Paid evals

**These runs start real Copilot sessions and spend AI credits.**
Review the [execution and scoped authentication setup](#execution-and-authentication)
before running any example. The local backend is not a container sandbox.

The [commit-attribution smoke eval](../evals/commit-attribution/skills/commit/commit.eval.yaml)
checks message drafting and routing, not installed-hook enforcement. The
[extended eval](../evals/commit-attribution/skills/commit/git-extended.eval.yaml)
checks actual commits, rejection recovery, and explicit amendments with the
real Git hook and synthetic runtime context. Both passed static validation;
neither has been run. The extended cases require a POSIX full-engine runner
and do not verify native plugin discovery. The separate `.mts` Git tests remain
outside the CI verification gate.
Run `npm run eval:list` to inspect the current selection without calling a model.

Execution readiness means every selected case finishes task execution
and grading without execution or grading errors. A completed behavioral
**FAIL** is still a valid graded result, not an infrastructure error; preserve
it for follow-up rather than changing skills, graders, or thresholds to force
a pass. Commands using `--require-pass`, including the manual workflow,
also require passing behavioral verdicts and can therefore exit unsuccessfully
even when execution and grading completed correctly.

Use Vally's built-in `skill-invocation` grader in skill evals: `required` for every
positive and boundary case, and `disallowed` for negative cases. Invocation
credit requires a matching `skill_activation` event. Successful file reads,
searches, path mentions, and completed answers do not count as invocation.
Custom program graders independently check the resulting files, output, and
side effects.

Repository evals inherit Vally's default local backend, with no project-level
backend override in [.vally.yaml](../.vally.yaml). Agent evals should stage the
actual custom agent and check its delegated result, not substitute a companion
skill or accept the parent's claim that the child succeeded.

### Execution and authentication

The starter leaves the backend unset. Native Vally 0.21.0 selects `local` when
no CLI, eval or project backend is specified. This is an intentional compatible
default, not a Docker failure fallback. Explicit eval selections, suites and the
standard-model experiment inherit it.

The project keeps the template's basic configuration shape: `environments`,
`params`, `metadata`, `paths`, and `suites`, without advanced project defaults.
This is not an installed-version or end-to-end compatibility test. Evals tools
still need a compatible runner, authentication, and approval for each run.
No Evals plugin is installed or enabled by this migration.
The SDK is pinned to the template's locked `@github/copilot-sdk` 1.0.31.
A newer transitive resolution produced incomplete platform-package entries;
the migration does not relax integrity checks to accept them.

Docker, Compose, image preparation and container network settings are not
prerequisites. The evaluator, task setup, tools and graders run on the host.
Disposable workspaces and a narrowly scoped credential do not isolate host
files, other processes, network access or the credential from evaluated code.
Review all declared effects before starting a run.

After `npm ci`, the manual CI workflow selects the repository-pinned Copilot
launcher using `COPILOT_CLI_PATH`. Local runs use the configured native runner.
Use only the authentication you intend to expose. For local evals, use a dedicated
[fine-grained token with the Copilot Requests account permission](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli#authenticating-with-environment-variables):
choose your personal account as resource owner, **Public repositories** access,
and only **Copilot Requests** under account permissions. The synthetic fixtures
need no private-repository access
or repository-write permissions. Do not reuse a broad `gh` login token.

For custom evals needing private GitHub access, use **Only select repositories**
where the personal-account token supports the required calls, and review minimum
read permissions. If it cannot meet a required call, review that requirement
separately rather than automatically broadening permissions.
This local user-token recommendation is separate from the manual Actions
workflow's repository/job-scoped `GITHUB_TOKEN` organization billing.

After adding an eval, replace `evals/<plugin>/eval.yaml` in the examples below
with its exact path and review its case and model plan before running it.
Enter the dedicated token at the hidden local prompt, without putting it in a
command, file, shell history or chat. The selected token is still readable by task processes
and can authorize Copilot usage; a narrower scope does not make it harmless.

Bash:

```sh
(
  unset COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN
  read -r -s -p "Copilot Requests-only token: " COPILOT_GITHUB_TOKEN || exit
  printf '\n'
  test -n "$COPILOT_GITHUB_TOKEN" || exit 1
  export COPILOT_GITHUB_TOKEN
  npm run eval -- --eval-spec "evals/<plugin>/eval.yaml" --max-retries 0
)
```

PowerShell:

```powershell
$names = 'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'
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
  npm run eval -- --eval-spec "evals/<plugin>/eval.yaml" --max-retries 0
  if ($LASTEXITCODE -ne 0) { throw "Eval exited with code $LASTEXITCODE; inspect its saved results." }
} finally {
  foreach ($name in $names) {
    [Environment]::SetEnvironmentVariable($name, $original[$name], 'Process')
  }
  $token = $null
  $secret = $null
}
```

Both examples clear all recognized tokens before selecting the dedicated token.
Bash confines changes to a subshell; PowerShell restores the original values
even if input or the eval fails. Do not enable shell tracing or print these
variables. Model-free recipe checks do not prove token access or actual model
authentication.

This uses the eval's declared model and one trial per case.

With the same explicitly selected authentication, `npm run eval -- --suite
smoke` selects the smoke cases and `npm run eval -- --suite full --max-retries
0` selects every case. Review the complete case/model plan and approve its
additional AI-credit exposure before starting.

### Standard model roster

[The native experiment](../evals/standard-models.experiment.yaml) is the single
source for the standard model roster: `claude-sonnet-5.5` and `gpt-6.1-terra`.
When adopting the template, replace `matrix.model.values` with your own model
IDs and set `baseline.model` to one of them. Vally requires at least two variants;
for a single model, use `npm run eval -- --model <model-id>` instead.

Once you have added evals, preview the selected cases, variants and configuration
hashes without running setup or a model:

```sh
npm run eval:models -- --dry-run
```

`npm run eval:models` executes the planned variants and spends AI credits for
each case under each model. Use the same scoped authentication above; the
experiment inherits the supported local-backend configuration.
The two-model roster is not a guarantee of account access or a quality claim.
The baseline identifies the experiment's control, not a preferred winner; the
command does not invoke an extra comparison judge. Only the model varies,
preserving the evals, graders, fixtures and selected assets.
The existing single-model commands and Actions do not consume this experiment.

Native experiments have a separate output flag rather than reading
`paths.results`. The npm command explicitly writes timestamped per-variant
results under `evals/results/standard-models/`. If you customize the output
location, update the command's `--output-dir` too.

### Saved results

For these direct Vally runs, results follow `paths.results` in
[.vally.yaml](../.vally.yaml), currently `evals/results/`. The report command
uses the same configured directory unless you supply an explicit results path.

Summarize the newest saved run (verdicts, scores, input/output/total tokens,
and duration) or compare a baseline run against a candidate run without calling
a model:

```sh
npm run eval:report
npm run eval:compare -- --baseline evals/_shared/fixtures/pr-description/baseline-results.jsonl --candidate evals/_shared/fixtures/pr-description/candidate-results.jsonl
```

[Evals](../.github/workflows/evals.yml) runs the smoke suite only when you
explicitly start it with **Run workflow** in GitHub Actions
(`workflow_dispatch`). Pull requests never start paid evals. Review the
selected branch and its eval code before dispatching a run.

## Template migration

Based on [github/plugin-marketplace-starter at 0b6bf97](https://github.com/github/plugin-marketplace-starter/tree/0b6bf97).
Only infrastructure improvements are adopted. Template plugins and their evals
stay removed. Synthetic report fixtures and compatibility tests are development
support, not installed plugins or behavioral coverage.

The original plugin implementations and their tests remain. Build, validation,
scaffolding, removal, and selection helpers moved from `scripts/` to
`.github/scripts/`. Existing npm commands remain, except `eval` now invokes
native Vally and `eval:report` uses the template's richer saved-run report.
For `--plugin` selection or absolute path params, use
`node .github/scripts/evals.mjs eval`; its matching report is
`npm run eval:report:selection`. New results use `evals/results/`; older
`vally-results/` files are untouched and can be supplied explicitly.

The checkout keeps its local-plugin development overlay. To try a plugin
elsewhere, pass its local folder with `--plugin-dir` or install it explicitly. The optional
remote Evals entry, network checks in the publishing gate, and mandatory eval
linting were not adopted. Static checks and headless tests do not establish
native host behavior or behavioral quality.
