# Continuous integration

## Model-free verification

[Validate marketplace](../.github/workflows/validate.yml) runs on pull requests,
pushes to `main`, and manual dispatch. It installs pinned dependencies and runs
`npm run verify` in one Linux job with Node.js 24.
The tests include the migrated template's catalog, report, and local-install
checks and the existing plugin tests. No model runs.
Windows, macOS, and Node.js 22 compatibility are not checked by CI.

`verify` checks vendored schemas offline and does not require behavioral evals
or strict eval linting. Network pin checks remain separate:
`npm run check-remotes`. Static success is not a safety or reliability claim.

Actions are pinned to full commit SHAs, checkout credentials are not persisted,
and superseded pull-request validation runs are cancelled.

## Optional paid evals

[Behavioral evals](../.github/workflows/evals.yml) currently starts only through
**Run workflow** in GitHub Actions. Select the branch and `smoke` or `full`
suite. The current workflow does not start evals for pull requests;
`ENABLE_EVALS` is no longer used.
Don't dispatch a run unless its AI-credit use and code execution are approved.

The job:

1. Installs pinned dependencies and checks the pinned Copilot runtime.
2. Runs native Vally with `gpt-6.1-terra`, one worker, one bounded retry, and
   `--require-pass`. Model access and pricing depend on the account; a pin does
   not verify either.
3. Adds the saved-run report to the job summary.
4. Uploads detailed results only if `EVALS_UPLOAD_RESULTS` is `true`, with
   seven-day retention.

The `evals` environment can require reviewers before credentials become
available. Configure that protection where the repository's GitHub plan
supports it; merely naming an environment does not require approval.
The job uses its repository-scoped `GITHUB_TOKEN` with
`copilot-requests: write`. Native Vally runs on the host, not in a container.

The command and report use `paths.results` in [.vally.yaml](../.vally.yaml),
currently `evals/results/`. Behavioral failures remain visible; execution,
grading, and incomplete-result errors fail the job. Paid runs are not cancelled
automatically by a newer push.

## Approved PR comparisons

[Compare PR evals](../.github/workflows/eval-pr.yml) is a separate, manually
dispatched workflow for the commit-attribution smoke eval. It does not yet
automatically run for trusted contributors or respond to approval labels.

After reviewing a PR's code and approving its AI-credit use, a maintainer can
choose **Run workflow** from `main`, enter the PR number and its exact
40-character head SHA, and approve the `evals` environment if required.
Fork PRs use the same manual approval. A changed head requires a new dispatch.

The workflow:

1. Captures the base and head skill files by immutable commit, without checking
   out or installing the PR's dependencies, setup scripts, or graders.
2. Uses the same smoke definition and runtime from the workflow's `main`
   revision for both sides, with `gpt-6.1-terra`, one worker, one trial per case,
   a two-minute trial timeout, and no evaluator retries.
3. Reports verdicts, score changes, tokens, and duration. It flags changed checks
   or execution settings; those PR changes are deliberately not evaluated.
   Missing cases, mismatched models, incomplete results, and infrastructure
   errors cannot count as improvements.
4. Saves only reduced result records for seven days, without prompts, responses,
   tool arguments, or raw grader evidence. A separate job with PR-write
   permission validates those records, rechecks the head, and updates one PR
   comment. The model-running job has no PR-write permission.

Only the skill directory changes between the two runs. Hook installation and
real-Git attribution behavior are outside this comparison; the extended evals
remain in the manual **Behavioral evals** workflow's `full` suite. The normal
`verify` test selection still excludes the real-Git `.mts` tests.

The comparison is not a security sandbox. An agent can execute tools despite
prompt instructions, and the model-running job has a read token with Copilot
access. Review skill contents before approving a run. One trial is a review
signal, not proof of improvement, and token counts are not a price estimate.
The comparison workflow and PR publication have not yet been exercised in
GitHub Actions. A local smoke run on 2026-11-16 with Vally 0.21.0 and the
evaluator's default `claude-sonnet-5.5` recorded one passed case and one failed
case. The drafted message had the correct co-author trailer, but the required
skill-invocation check failed. The status-question case passed. This is not a
result for the CI-pinned `gpt-6.1-terra`; the checks were not weakened.

## Security

Review the selected branch before dispatch. Its setup commands, tools, plugin
code, and graders run with the job's permissions and can use its Copilot
credential. Keep fixtures synthetic. Protect workflow and eval changes with
code review and branch rules appropriate to the repository.

Transcripts can contain prompts, model output, and code. Keep detailed uploads
off unless you intend to share them with everyone who can read Actions
artifacts. Logs and job summaries still follow the repository's access and
retention settings.

For local runs, follow [scoped authentication](checks-and-evals.md#execution-and-authentication);
don't reuse a broad GitHub CLI token. See [data handling](security.md).
