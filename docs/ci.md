# Continuous integration

Two workflows ship with the template.

## Deterministic checks

[validate.yml](../.github/workflows/validate.yml) runs `npm ci` and
`npm run verify` on Linux, Windows, and macOS with Node.js 22 and 24. It never
calls a model and needs only read access. On its own, it's enough to keep the
marketplace consistent. Model-free doesn't mean nothing runs: it installs
dependencies and runs this repository's scripts and tests.

- **When it runs.** On every pull request, on pushes to `main`, and by hand
  from the **Actions** tab. A push to a pull request's branch runs once,
  through the pull request, not twice. If your default branch has another
  name, change `branches: [main]` in the workflow.
- **Superseded runs.** A newer push to a pull request cancels the run it
  replaces. Runs on `main` always finish, so every commit there gets a result.
- **Jobs.** It runs six jobs: three operating systems times two Node.js
  versions. macOS and Windows minutes cost more than Linux minutes in a
  private repository, so to use fewer Actions minutes, trim the `os` or `node`
  list in the matrix to the systems and versions your team uses.
  `npm run verify` only needs at least one of each, with Node.js 22 or newer.
- **Required checks.** Each job reports a check named
  `validate (<os>, Node.js <version>)`, such as
  `validate (ubuntu-latest, Node.js 24)`. In a ruleset or branch protection,
  require each one you want enforced; there's no single check named after the
  workflow.

The tests that read the workflows check only what keeps CI safe and
model-free, not their exact shape, so the changes this page describes (a
smaller matrix, no `evals` environment, a debug run with transcripts, or no
`evals.yml` at all) keep `npm run verify` passing.

## Personal accounts

If the repository belongs to your personal account rather than an
organization:

- `validate.yml` works as it is, and it's all you need to keep the marketplace
  consistent. It never calls a model.
- Copilot usage from the job's token is
  [billed to your own Copilot plan](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions).
  Each plan includes a monthly allowance of AI credits; see
  [Copilot plans](https://docs.github.com/en/copilot/get-started/plans) and
  [billing for individuals](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing).
  Copilot Free and Copilot Student use automatic model selection only, so evals
  that name `gpt-5.4-mini` may not run on those plans. That isn't verified.
- Run `npm run eval:smoke` locally first to see what a run costs, then try a
  manual run in CI before you turn on pull request runs.
- Required reviewers on the `evals` environment work only in public
  repositories on personal plans. In a private personal repository, leave
  `ENABLE_EVALS` unset and run evals by hand. GitHub Free can't configure
  environments for private repositories at all; this template hasn't verified
  how a job that names one behaves there, so if the eval job fails on the
  environment, delete the `environment: evals` lines from `evals.yml`.
  `npm run verify` still passes without them. See
  [deployment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers).

## Behavioral evals

[evals.yml](../.github/workflows/evals.yml) runs the eval suites with real
Copilot sessions, so it costs AI credits. It's off for pull requests until you
turn it on.

### Turn it on

1. Check the [requirements](#requirements) below.
2. Decide who approves runs. The eval job uses an environment named `evals`,
   which GitHub creates the first time a job uses it. To make a person approve
   each run before it gets a token, add required reviewers to it in
   **Settings** > **Environments** > **evals**. On GitHub Free, Pro, and Team
   plans, required reviewers work only in public repositories; private
   repositories need GitHub Enterprise. See
   [deployment protection rules](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments#required-reviewers),
   and [Security](#security) for what this does and doesn't stop.
3. Try a manual run first: **Actions** > **Behavioral evals** > **Run
   workflow**, and choose `smoke`. Manual runs work whether or not evals are
   turned on for pull requests.
4. To run the `smoke` suite on pull requests, create the repository variable
   `ENABLE_EVALS` with the value `true`. Repository variables live in
   **Settings** > **Secrets and variables** > **Actions** > **Variables**.

Pull request runs start only when all of these hold:

- `ENABLE_EVALS` is `true`.
- The branch is in this repository. Fork pull requests never get credentialed
  eval runs, and there's no `pull_request_target` trigger.
- The pull request isn't a draft. Marking it ready for review starts a run.
- It touches plugins, evals, schemas, scripts, `.vally.yaml`, the package
  files, or the workflow itself.

Runs don't cancel each other, so a paid run never stops halfway. Each push to
an open pull request queues one more run, so keep work-in-progress pull
requests as drafts.

### What the job does

The job uses the same launcher you use locally, with the pinned
[Vally CLI](https://microsoft.github.io/vally/) from `package.json` and the
job's `GITHUB_TOKEN` passed to the Copilot runtime, as
[Vally's CI guide](https://microsoft.github.io/vally/get-started/add-to-ci/)
describes. The job:

1. Sets up Node.js 24 and runs `npm ci`, so Vally, graders, eval MCP hosts, and
   the pinned full Copilot runtime are available.
2. Checks that the runtime bridge starts the pinned runtime. It prints the
   pinned Copilot CLI version and the version that actually runs.
3. Runs `node scripts/evals.mjs eval --suite <suite> --require-pass`, with one
   worker and one bounded retry.
4. Runs `node scripts/eval-report.mjs` and adds the report to the job summary.

The job fails on a failed verdict, an incomplete run, or an infrastructure
error, unlike the report-only default of `npm run eval:report` locally. Its
token has `contents: read` and `copilot-requests: write`.

Results include transcripts, which can contain prompts, model output, and code.
The job uploads them as an artifact only when you set the repository variable
`EVALS_UPLOAD_RESULTS` to `true`. Set it temporarily when you need to debug a
run, review who can read workflow artifacts, and unset it when you're done.

## Requirements

- **Organization billing policy.** In an organization-owned repository, the job
  token's Copilot usage is billed to the organization. An organization owner
  must allow it: **Organization settings** > **Copilot** > **Policies** >
  **Copilot CLI** > **Allow use of Copilot CLI billed to the organization**.
  It's on by default for organizations with Copilot CLI turned on, and an
  enterprise policy can override it. In a personal repository, usage is billed
  to the owner's Copilot plan. See
  [Copilot CLI in GitHub Actions](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions)
  and [managing Copilot policies](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-policies).
- **`copilot-requests: write`.** The workflow grants this job permission so the
  token can make Copilot requests. See
  [using Copilot CLI in GitHub Actions with GITHUB_TOKEN](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions).
- **Runners.** The job uses `ubuntu-latest`. Other runners aren't verified.
- **Actions policy.** If your organization restricts which actions can run,
  allow the actions the workflow pins: `actions/checkout`, `actions/setup-node`,
  and `actions/upload-artifact`.

## Cost

Each case runs at least one Copilot session with `gpt-5.4-mini`, and a retried
case runs again. `npm run eval:check` prints how many cases each suite has, and
`npm run eval:list -- --suite smoke` lists them. Copilot bills model usage in AI
credits based on the model and tokens used, so a case that delegates to an
agent or edits files costs more than a one-turn chat case. When usage is billed
to the organization, user-level Copilot budgets don't apply; use cost centers
and the organization's usage dashboards instead. See
[usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing).
After your first manual run, check the dashboard to learn what a run costs.

## Security

Same-repository pull requests run their own versions of plugin hooks, MCP
servers, graders, and scripts with the eval job's token, which can make billed
Copilot requests.
Merge review doesn't protect this: the code runs when the pull request is
opened or updated, before anyone reviews it. Fork pull requests never get these
runs.

Required reviewers on the `evals` environment add a check before each run:
someone has to approve it, and a new push needs a new approval. That still has
a gap. A pull request run uses the workflow file from the pull request's own
branch, so someone who can push a branch here can edit `evals.yml` to drop the
environment. Treat write access to this repository as the trust boundary. If
that's not enough for your team, leave `ENABLE_EVALS` unset and run evals only
by hand, from a reviewed branch.

Before you turn on `ENABLE_EVALS`:

- Protect the default branch with
  [branch protection or a ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)
  that requires review and the `validate (<os>, Node.js <version>)` checks from
  the **Validate marketplace** workflow. Each matrix job is its own check, so
  add every one you want enforced.
- Set [code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
  for `.github/workflows/`, `scripts/`, `evals/`, `plugins/`, `marketplace.json`,
  and `.github/copilot/settings.json`, and require their review in the rule. A
  `CODEOWNERS` file alone doesn't enforce anything.
- Add required reviewers to the `evals` environment, as described above.
- Every action is pinned to a full commit SHA, and checkout doesn't persist
  credentials. Keep it that way.

[Security and data handling](security.md#data-flow) lists what the job
writes, who can read it, and for how long.

## Turn evals off

Leave `ENABLE_EVALS` unset, or delete it, and pull requests won't run evals.
To remove them from CI completely, delete `.github/workflows/evals.yml`;
`validate.yml` still checks everything that doesn't need a model, and you can
still run evals locally.
