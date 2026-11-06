# Examples

The starter ships six self-contained example plugins. Keep them as references,
copy one as a starting point, or remove them with
`npm run remove-example -- <name>`. Removing an example deletes its section
below too.

Each example owns `plugins/<name>/`, `evals/<name>/`, and the extra files
listed in its section. [scripts/examples.mjs](../scripts/examples.mjs) holds the
same list, which `remove-example` and the example-only tests use. If you add a
test, grader, fixture, or param for an example, add it there too. Removing the
last example removes this page as well.

The eval coverage for each example establishes its stated contract, not
universal bug-report quality, review accuracy, or brainstorming creativity.

<!-- plugin:bug-report -->
## bug-report

[bug-report](../plugins/bug-report/) is the smallest example: one skill and two
Markdown templates. It's the best one to copy for a skill that answers in chat.

- **Teaches:** a skill that loads only the template it needs and asks for
  missing details instead of inventing them. Type: skill.
- **Evals:** UI versus CLI template selection, supplied facts, missing
  reproduction details, example-credential redaction, and requests that
  shouldn't trigger it. Drafts stay in chat; no issue creation or commands.
- **Also owns:** `evals/graders/bug-report.mjs` and
  `test/grader-bug-report.test.mjs`.
- **Host checks:** see [Host checks](../plugins/bug-report/README.md#host-checks) in
  its README.
<!-- /plugin:bug-report -->

<!-- plugin:format-json -->
## format-json

[format-json](../plugins/format-json/) is a `postToolUse` hook that formats the
JSON files an agent edit touched. It has no skill.

- **Teaches:** a CLI-compatible hook that selects affected files from the tool
  event and never makes permission decisions. Type: hook.
- **Evals:** a real compact agent edit triggers the packaged hook, and malformed
  JSON stays unchanged with a diagnostic. The grader requires the hook's actual
  receipt and file effects, not a model's claim that it formatted the file.
- **Also owns:** `evals/graders/format-json.mjs`, `test/hook.test.mjs`, and
  `test/grader-format-json.test.mjs`.
- **Host checks:** see [Host checks](../plugins/format-json/README.md#host-checks) in
  its README.

The hook rewrites JSON files after agent edits. A hook isn't a security
boundary and doesn't replace CI.
<!-- /plugin:format-json -->

<!-- plugin:team-brainstorm -->
## team-brainstorm

[team-brainstorm](../plugins/team-brainstorm/) pairs a skill with a canvas
extension: a shared, session-only board that a person and Copilot both edit.

- **Teaches:** SDK canvas actions, a loopback server that checks `Host` and
  `Origin`, and a skill that falls back to chat when the host has no canvas.
  Types: skill and extension.
- **Evals:** preserve existing notes, add two ideas, move a note by its real ID
  across turns, fall back to chat without a canvas, and don't trigger for
  arithmetic. The extension cases drive the real registered actions and session
  state through an MCP test transport.
- **Also owns:** `evals/graders/brainstorm.mjs`, the `BRAINSTORM_EXTENSION`
  param, and `test/board.test.mjs`,
  `test/board-ui.test.mjs`, `test/brainstorm-eval-host.test.mjs`,
  `test/extension.test.mjs`, and `test/grader-brainstorm.test.mjs`.
- **Host checks:** see [Host checks](../plugins/team-brainstorm/README.md#host-checks) in
  its README.

The extension evals use the shared
[headless canvas host](../evals/support/canvas-host.mjs), which serves MCP only
as an evaluation transport. Three transport exports stand in for the host,
while the actual extension, board logic, HTTP server, and lifecycle callbacks
run unchanged. The eval seeds one synthetic note, the host keeps state only for
that eval session, closes its servers when done, and never returns a localhost
URL to the model. Only the canvas cases connect to it; the no-canvas case still
checks the chat fallback. Neither the host nor the model-free tests prove that
any app renders the canvas; see
[where each type works](customization-types.md#where-each-type-works).
<!-- /plugin:team-brainstorm -->

<!-- plugin:customization-authoring -->
## customization-authoring

[customization-authoring](../plugins/customization-authoring/) is a skill that
writes a new skill and its Vally eval.

- **Teaches:** progressive disclosure through a `references/` file, and writing
  generated files into the user's workspace rather than the installed skill
  directory. Type: skill.
- **Evals:** actual activation, generated skill and eval files, strict
  validation of those files with the pinned Vally CLI, and a question that
  shouldn't trigger it. Generated files are graded in a disposable workspace.
- **Also owns:** `evals/graders/src/authoring.mjs`, its generated
  `evals/graders/dist/` bundle and notices, the `MARKETPLACE_VALLY_CLI` param,
  and `test/authoring-grader.test.mjs`.
- **Host checks:** see [Host checks](../plugins/customization-authoring/README.md#host-checks) in
  its README.
<!-- /plugin:customization-authoring -->

<!-- plugin:code-review -->
## code-review

[code-review](../plugins/code-review/) pairs a review skill with a read-only
custom agent it delegates to.

- **Teaches:** a skill that delegates to a bundled agent by its advertised
  identifier (`code-review:code-reviewer` in Copilot CLI), and a least-privilege
  tool list. Types: skill and agent.
- **Evals:** actual named-agent delegation, findings from that subagent for a
  seeded bug, a clean case, the agent without its skill, and no workspace edits.
  The default agent's answer isn't accepted as the reviewer's.
- **Also owns:** `evals/fixtures/review/`.
- **Host checks:** see [Host checks](../plugins/code-review/README.md#host-checks) in
  its README.
<!-- /plugin:code-review -->

<!-- plugin:json-configuration -->
## json-configuration

[json-configuration](../plugins/json-configuration/) pairs a skill with a
bundled local MCP server that validates JSON and reads values by JSON Pointer.

- **Teaches:** a self-contained stdio MCP server built from `src/server.ts` into
  a committed bundle with its license notices. Types: skill and MCP server.
- **Evals:** actual MCP calls and their returned values or errors, including
  null versus missing values and pointer escaping. The real bundled server runs
  over stdio.
- **Also owns:** the `JSON_MCP_SERVER` param, `test/json-tools.test.mjs`, and
  `test/mcp-protocol.test.mjs`.
- **Host checks:** see [Host checks](../plugins/json-configuration/README.md#host-checks) in
  its README.
<!-- /plugin:json-configuration -->
