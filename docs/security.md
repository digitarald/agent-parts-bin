# Security and data handling

This page is for whoever approves this marketplace for a team: what runs, when,
with what access, and where data goes. [SECURITY.md](../SECURITY.md) covers
reporting a vulnerability. [Continuous integration](ci.md#security) covers the
eval workflow in detail.

None of this is a sandbox. Hooks, MCP servers, extensions, graders, and scripts
run as ordinary processes with the permissions of the account that runs them.
The checks described here reduce mistakes and some attacks; they don't contain
malicious code.

## When plugin code runs

| Step | What happens |
|---|---|
| Add the marketplace, or install a plugin | Copilot registers the plugin. Nothing in the plugin runs yet. |
| Copilot loads an installed, enabled plugin | Extensions and MCP servers can start, depending on the host. From here on, the plugin's code can run. |
| An event fires, such as a successful edit | Hooks run, automatically, without asking each time. |
| The model picks a skill, agent, or tool | Skills and agents shape what the model does next; tools run their code. |

Opening a trusted checkout of this repository counts as installing every local
plugin: the [repository overlay](../.github/copilot/settings.json) enables them
all for that checkout. Only trust the checkout if you'd install all of its
plugins.

## Data flow

| Data | Where it goes | Who can read it, and for how long |
|---|---|---|
| Prompts, files the agent reads, tool arguments and results, hook messages, MCP results, and canvas notes the agent reads | Copilot and the model behind it | Set by your Copilot plan and policies, not by this template. See the [GitHub Copilot Trust Center](https://copilot.github.trust.page/). |
| Local eval results in `vally-results/`: results, a report, JUnit, and session evidence with transcripts | Your disk | Gitignored. Delete them when you're done. |
| The eval job in CI: Vally's log and the report in the job summary | The workflow run | Anyone who can read the repository's Actions runs. Logs follow the repository's [retention setting](https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization) (90 days by default). |
| The eval job's results artifact, which includes transcripts | A workflow artifact | Only when `EVALS_UPLOAD_RESULTS` is `true`. Kept for 7 days. |
| Vally telemetry | Vally's telemetry service, unless turned off | `VALLY_TELEMETRY_OPTOUT=1` is set by `validate.yml`, the local launcher, and the eval job. |
| Copilot CLI telemetry | GitHub | Set by Copilot's own settings and policies, not by this template. |

Grader evidence can quote what the model said, and transcripts hold prompts,
model output, and file contents. Keep every fixture, prompt, and expected
answer synthetic, and treat reports, logs, and artifacts as possibly
sensitive.

Data a plugin keeps for itself, such as a canvas's state or an MCP server's
cache, lives wherever its code puts it. The review table below asks for it.

<!-- examples -->
## What the examples do and don't do

<!-- /examples -->
<!-- plugin:bug-report -->
- **bug-report** reads only its own templates and the notes you give it, and
  drafts the report in chat. It doesn't write files, run commands, or file an
  issue. Its evals check that it leaves an example credential out of the draft,
  but remove secrets from your notes yourself.
<!-- /plugin:bug-report -->
<!-- plugin:code-review -->
- **code-review** gives its agent only the `read` and `search` tools, so it
  reads the code you point it at and sends it to the model, but never edits,
  runs code, commits, or posts comments.
<!-- /plugin:code-review -->
<!-- plugin:customization-authoring -->
- **customization-authoring** writes the skill and eval files it generates into
  your workspace, never inside the installed plugin. It doesn't run paid evals
  unless you ask.
<!-- /plugin:customization-authoring -->
<!-- plugin:format-json -->
- **format-json** reads only the files a successful edit named, inside the
  session's working directory, and rejects symbolic links. Its diagnostics name
  the file and the line and column of a parse error, never the file's content.
  It has no limit on file size, and file selection isn't a race-proof boundary.
<!-- /plugin:format-json -->
<!-- plugin:json-configuration -->
- **json-configuration** handles only the JSON passed to it: no files,
  credentials, network, or storage. It returns results to Copilot, which sends
  them to the model. Input is capped at 1,048,576 characters, and errors don't
  quote the input. The process itself still has your account's permissions.
<!-- /plugin:json-configuration -->
<!-- plugin:team-brainstorm -->
- **team-brainstorm** keeps notes in the extension's memory until it stops,
  and the model sees every note the agent reads. It binds to `127.0.0.1`,
  checks `Host` and `Origin`, and serves each panel under a random path. That
  stops web pages and casual local requests, not software running as your
  account. Don't put sensitive data on the board.
<!-- /plugin:team-brainstorm -->

## Dependencies

- Every development dependency is pinned to an exact version, and the lockfile
  records a sha512 integrity hash for each package. The template resolves them
  all from `registry.npmjs.org`; if your team uses a mirror, `npm ci` follows
  your npm configuration instead.
- `npm ci` runs install scripts. Three packages have one: `@vscode/deviceid`,
  `esbuild`, and `koffi`. Use `npm ci --ignore-scripts` only if you've checked
  that the tools you need still work without them.
- Every dependency is a development dependency, so `npm audit --omit=dev`
  checks nothing. The MCP server and grader bundles in `dist/` include
  third-party code, listed in the `THIRD_PARTY_NOTICES.txt` beside each one.
  Audit the full graph with `npm audit` and review those notices.
- `npm run verify` runs code from the checkout and its dependencies, including
  each local MCP server. Model-free doesn't mean nothing runs.

## Remote plugins

A remote entry must pin a full commit `sha`, and `npm run verify` fails without
one. `npm run check-remotes` confirms the pin exists and the upstream name
matches. Neither proves the upstream code is safe: review it as you would any
dependency. Removing an entry from this catalog doesn't stop people installing
the same plugin from another marketplace; if you need that, use your
organization's Copilot policies where they're available (not verified by this
template). See [Remote plugins](remote-plugins.md).

## Review a plugin

Copy this into the pull request or issue for any plugin that's new or that
changes what it can do. Write "none" where it doesn't apply.

| Question | Answer |
|---|---|
| What runs, and when: hooks and their events, MCP servers, extensions, scripts | |
| Files it reads or writes, and how it limits them | |
| Network destinations | |
| Credentials or tokens it uses, and where they come from | |
| Data it keeps, where, and for how long | |
| Data it sends to the model, such as file contents or tool results | |
| New dependencies, their licenses, and install scripts | |
| Remote sources: repository, path, and pinned sha | |
| Who owns it, and who approved it | |
