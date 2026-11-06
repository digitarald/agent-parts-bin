# Format JSON

A `postToolUse` hook that formats JSON files after successful agent edits.
There is no skill to invoke. It runs in Copilot CLI and in VS Code sessions
that use the Copilot harness; see
[where each type works](../../docs/customization-types.md#where-each-type-works).

## Install

```sh
copilot plugin marketplace add OWNER/REPO
copilot plugin install format-json@MARKETPLACE
```

Replace `OWNER/REPO` with the GitHub repository that hosts this marketplace
and `MARKETPLACE` with the `name` in its `marketplace.json`. See
[Install plugins](../../README.md#install-plugins) for VS Code.

## How it works

The hook reads `toolName`, `toolArgs`, `toolResult.resultType`, and `cwd` from
the Copilot CLI hook event, described in
[Hooks](../../docs/hooks.md#the-posttooluse-event). Only a `success` result can trigger formatting.
It supports these tool inputs:

| Tool | Affected paths |
|---|---|
| `create`, `edit` | `path` |
| `create_file`, `replace_string_in_file` | `filePath` |
| `multi_replace_string_in_file` | Each `replacements[].filePath` |
| `apply_patch` | Add/update headers and move destinations, excluding deletions |

`toolArgs` may be an object or JSON-encoded string. `apply_patch` also accepts
the raw patch string and the runtime's `input` or `patch` object forms.
Paths resolve against the event's `cwd`, not the hook process directory.

For each affected `.json` file, the hook uses Node's `JSON.parse` and
`JSON.stringify` to produce two-space indentation, or the `--indent` you
configure, and a final newline. It leaves already formatted files untouched.
Invalid JSON stays unchanged, with a diagnostic on stderr and in the
assistant's tool context. The diagnostic names the file and the line and
column of the error, never the file's content, because Node's own parser
messages can quote the input. Other file errors are reported the same way,
without stopping the remaining files. Changed paths are returned as
`additionalContext` so the assistant knows to re-read the file.

No directory scans, shell commands, formatter downloads, or commit checks.
No permission decisions or tool-result replacements. Unrelated tools and
failed edits return `{}`.

## Requirements and limits

- Node.js 22.12+; no plugin runtime dependencies.
- A host that runs Copilot CLI hooks: Copilot CLI, or a VS Code session that
  uses the Copilot harness. VS Code's Local harness sends a different event
  shape, so the hook reports a diagnostic there instead of formatting.
- Only regular JSON files below the session working directory are eligible.
  Symbolic links and paths outside that directory produce a diagnostic.
- JSONC, comments, and trailing commas are not supported. Node's JSON number
  precision rules apply, so do not use this example for precision-sensitive
  numeric data.
- Shell-based writes and unrecognized edit tools are not detected. The hook
  does not roll back edits, enforce policy, or replace CI.

## Customize

To change the indentation, add `--indent N` (1 to 10) to the command in
[hooks.json](com.github.copilot/hooks/hooks.json):

```json
"command": "node \"${PLUGIN_ROOT}/com.github.copilot/hooks/format.mjs\" --indent 4"
```

Then change the last grader argument in
[the eval](../../evals/format-json/eval.yaml) from `'2'` to `'4'`, bump the
version, and run `npm run verify`. A test fails if the configured command and
the eval disagree. The script rejects any other argument with a diagnostic
instead of ignoring it.

To use Prettier, Ruff, or another formatter, replace this script with your
team's formatter invocation and declare its prerequisites. Keep the affected-file
selection and report any content changed after the tool ran. Update
`test/hook.test.mjs` and the grader in `evals/graders/format-json.mjs` to match
the new output.

## Host checks

Before a release, try these by hand in each host you support. Automated tests
and evals don't prove that a host loads or shows everything.

- Edit JSON with a single-file edit, a multi-file edit, and `apply_patch`.
  Confirm two-space formatting (or your `--indent`), a final newline, and a
  message that names each changed file.
- Confirm failed edits and unrelated files stay untouched, invalid JSON stays
  unchanged with a visible diagnostic, and already formatted JSON isn't
  rewritten.
- In VS Code, try it in a session that uses the Copilot harness.
