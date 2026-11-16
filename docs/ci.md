# Continuous integration

## Model-free verification

[Validate marketplace](../.github/workflows/validate.yml) runs on pull requests,
pushes to `main`, and manual dispatch. It installs pinned dependencies and runs
`npm run verify` on Linux, Windows, and macOS with Node.js 22 and 24.
The tests include the migrated template's catalog, report, and local-install
checks and the existing plugin tests. No model runs.

`verify` checks vendored schemas offline and does not require behavioral evals
or strict eval linting. Network pin checks remain separate:
`npm run check-remotes`. Static success is not a safety or reliability claim.

Actions are pinned to full commit SHAs, checkout credentials are not persisted,
and superseded pull-request validation runs are cancelled.

## Optional paid evals

[Behavioral evals](../.github/workflows/evals.yml) starts only through
**Run workflow** in GitHub Actions. Select the branch and `smoke` or `full`
suite. Pull requests never start paid evals; `ENABLE_EVALS` is no longer used.
Don't dispatch a run unless its AI-credit use and code execution are approved.

The job:

1. Installs pinned dependencies and checks the pinned Copilot runtime.
2. Runs native Vally with one worker, one bounded retry, and `--require-pass`.
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
