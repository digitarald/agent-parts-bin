# Hooks

A hook runs a command when something happens in a Copilot session, such as
after every tool call. This guide covers what a plugin hook receives and
returns, how to scaffold and test one, and how to prove in an eval that it ran.
The official [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
is the source of truth; this page summarizes the parts plugin hooks use.

## Where hooks run

Plugin hooks use the Copilot CLI hook format, so they run where the Copilot
CLI runtime runs: Copilot CLI, and VS Code sessions that use the Copilot
harness. VS Code's Local harness reads the same file but sends a different
event shape, so a hook written for the CLI format doesn't get the fields it
expects there. See [where each type works](customization-types.md#where-each-type-works).

A hook isn't a security boundary. It runs with the permissions of the person
using Copilot, and it doesn't replace CI.

## Scaffold one

```sh
npm run new-plugin -- lint-on-save --no-skill --with hook
```

That writes:

- `com.github.copilot/hooks/hooks.json` in the plugin, which runs the script
  after every tool call.
- `com.github.copilot/hooks/lint-on-save.mjs`, a script that reports
  successful edits.
- `test/lint-on-save-hook.test.mjs`, model-free tests that run the script the
  way Copilot does.
- `evals/lint-on-save/eval.yaml`, with a positive case that proves the hook ran
  and a negative case.

Drop `--no-skill` to also get a skill.

## hooks.json

```json
{
  "version": 1,
  "hooks": {
    "postToolUse": [
      {
        "type": "command",
        "command": "node \"${PLUGIN_ROOT}/com.github.copilot/hooks/lint-on-save.mjs\"",
        "timeoutSec": 10
      }
    ]
  }
}
```

`npm run verify` checks the event names against the reference, and that every
command runs `node "${PLUGIN_ROOT}/<script>"`, optionally followed by
arguments, with a script inside the plugin. It can't tell whether your script
reads those arguments, so have the script reject arguments it doesn't support,
and test the exact command from `hooks.json`.

## The postToolUse event

Copilot writes the event to the script's stdin as JSON. For a `postToolUse`
hook registered under the camelCase name, the fields are:

| Field | What it holds |
|---|---|
| `toolName` | The tool that ran, such as `apply_patch`, `edit`, or `bash` |
| `toolArgs` | The tool's arguments. Treat it as unknown: it may be an object or a JSON string |
| `toolResult.resultType` | `success` for a successful call. Check this before you act |
| `toolResult.textResultForLlm` | The result text the model sees |
| `cwd` | The session's working directory. Resolve relative paths against it, not the hook's own directory |
| `sessionId`, `timestamp` | Identify the session and when the call ran |

Edit tools name their files differently:

| Tool | Where the affected paths are |
|---|---|
| `create`, `edit` | `toolArgs.path` |
| `create_file`, `replace_string_in_file` | `toolArgs.filePath` |
| `multi_replace_string_in_file` | Each `toolArgs.replacements[].filePath` |
| `apply_patch` | The `*** Add File:`, `*** Update File:`, and `*** Move to:` lines of the patch, which may be the raw string or its `input` or `patch` field |

Shell commands can write files too, and a hook can't see which ones. Tool names
and shapes can change between Copilot versions, so cover the ones you rely on
in tests.

The script writes a JSON object to stdout:

- `{}` keeps the tool result as it was.
- `{ "additionalContext": "..." }` appends text to the tool result, so the model
  sees it right after the tool output.

The reference also documents `modifiedResult`, which replaces the result, and
permission decisions for `preToolUse`. The hooks in this marketplace never
return permission decisions and don't replace tool results.

## A minimal hook

```js
import { readFileSync } from "node:fs";

let result = {};
try {
  const event = JSON.parse(readFileSync(0, "utf8"));
  if (event.toolName === "apply_patch" && event.toolResult?.resultType === "success") {
    result = { additionalContext: "lint-on-save: checked the edited files." };
  }
} catch {
  // Don't echo the input; it can hold file contents.
  result = { additionalContext: "lint-on-save: hook input isn't valid JSON." };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
```

Start every message with `<plugin-name>:`. People can tell where it came from,
and evals can use it to prove the hook ran. Never put file contents or raw
parser messages in a message: they go to the model, and Node's `JSON.parse`
errors can quote the input.

## Test it without a model

Run the script the way Copilot does: the event on stdin, JSON on stdout. The
scaffolded `test/<name>-hook.test.mjs` shows the pattern. Cover a
successful edit, a failed edit, an unrelated tool, bad input, and the exact
command and arguments in `hooks.json`.

Installing a plugin doesn't prove a hook loads: `copilot plugin install`
reports skills, not hooks, so a typo in `hooks.json` looks the same as a
working hook. Check by hand in each host you support; see
[Before a release](local-development.md#before-a-release).

## Prove it ran in an eval

The eval mounts the real plugin with `agent_environment.env.STARTER_PLUGIN_DIRS`
and needs evidence that comes from the hook itself, not from the model doing
the task. The coverage check accepts:

- A `program` grader that checks the hook's real effects, such as a file it
  rewrote.
- A `tool-calls` rule whose `result` pattern includes the hook's
  `<plugin-name>:` prefix. Copilot appends the hook's `additionalContext` to
  the tool result, so only the hook can put it there. This is the best
  built-in evidence for a hook that reports rather than changes files.
- An `output-matches`, `output-contains`, or `file-matches` grader whose
  pattern includes the prefix.

It rejects a file grader that only checks content the model wrote, because
that passes even when the hook never ran. See [Evals](evals.md#hooks).
