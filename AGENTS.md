# Maintaining this marketplace

Follow [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), and the
guides in [docs/](docs/) for team setup, package layout, installation,
versioning, validation, evals, CI, and host checks. Update those instructions in
place; don't duplicate them here.

## Agent-specific rules

- Scaffold a plugin with `npm run new-plugin -- <name>` (with `--with agent`,
  `mcp`, `hook`, or `extension`, and `--no-skill` when it has no skill), remove
  one with `npm run remove-plugin -- <name>` (`remove-example` for the shipped
  examples), and rename the marketplace with `npm run rename-marketplace`,
  rather than editing the catalog, overlay, and `.vally.yaml` by hand. Name a
  plugin's support files after it (`evals/graders/<name>.mjs`,
  `test/<name>-*.test.mjs`) so removal finds them.
- Group plugins by workflow, not by asset type. Keep every in-repo example
  self-contained and independently installable, without external services.
  Remote catalog references are separate from the local examples.
- Keep `.vally.yaml` in step with the plugins: `paths.skills` lists every
  plugin's `skills` directory, and path `params` point at files that exist.
  Live-repository tests check invariants, not a fixed plugin list; put
  example-specific assertions in tests that skip when the example is gone, and
  list every file an example owns in [scripts/examples.mjs](scripts/examples.mjs).
- Use the Agent Plugins 1.0 layout: root `plugin.json`, `skills/`, and `mcp.json`.
  Copilot agents (`agents/`), slash commands (`commands/`), rules (`rules/`),
  hooks (`hooks/hooks.json`), LSP servers (`lsp.json`), and SDK extensions
  (`extensions/`) live under `com.github.copilot/`. Check the
  [plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#components)
  before adding a component type the examples don't show. Don't ship rules or
  slash commands until the reference documents their file format; validation
  only checks that those files aren't empty. Use a skill for shared standards.
  Don't adopt legacy `.plugin/` or `.claude-plugin/` layouts from documentation.
  VS Code automation templates (`automations/*.automation.md` at the plugin
  root) are a VS Code-only capability, not an Agent Plugins 1.0 component, and
  `verify` doesn't check them.
- Instruction files (`.github/copilot-instructions.md`, `*.instructions.md`,
  `AGENTS.md`) and prompt files apply only to the repository they're in. To
  share guidance through the marketplace, package it as a skill or agent, as
  [docs/customization-types.md](docs/customization-types.md) explains.
- Don't add a UI framework or database. Never vendor the runtime SDK. The only
  build step regenerates committed artifacts (the MCP server bundle, the
  authoring grader, and their notices). Run `npm run build` after changing their
  sources and commit the generated files with the change. Never make an
  installed plugin depend on this checkout's `node_modules`.
- Skill and agent descriptions explain when to invoke them. Put detailed
  instructions in the body, and don't duplicate a skill as a command.
- Formatter hooks must not return permission decisions. Return `{}` for no-ops,
  and never describe the hook as a security boundary or replacement for CI.
  Prefix hook messages with `<plugin-name>:`, and never put file contents or raw
  parser messages in them. See [docs/hooks.md](docs/hooks.md).
- Don't claim a customization type works in a host unless official docs say so;
  keep the matrix in [docs/customization-types.md](docs/customization-types.md)
  in step, and write "not verified" where they don't.
- Preserve coverage when replacing an example; don't delete tests just to
  make validation pass.
- Keep evals outside plugins, grouped by workflow under `evals/`. Update the
  corresponding evals whenever adding or changing an in-repo skill, agent, hook,
  extension, or MCP tool. Don't replace real skill, tool, or agent invocation
  assertions with output keywords. Keep eval-only transports and development
  dependencies outside `plugins/`. Headless contract results aren't proof of
  native canvas rendering.
- Never stage answer keys or eval specifications into the agent's workspace. Use
  only synthetic fixtures and disposable directories, not git worktrees.
- Inspect failed trajectories before changing assertions. Don't loosen a check
  just to get green results, and don't accept the default agent's answer when a
  custom agent failed to launch. A grader infrastructure exception must report
  `status: error`, not a failed behavioral verdict.
- Valid behavioral failures may be report-only locally; tooling, configuration,
  and grader errors must fail. Never hide failures with blanket catches or
  `continue-on-error`.
- `npm run eval:smoke`, `npm run eval`, and the evals workflow spend AI
  credits. Don't run them unless the user asks, and don't turn on
  `ENABLE_EVALS` for anyone. Static checks don't establish behavioral quality.
- When upgrading Vally or Copilot, update the pins in `package.json` and the
  lockfile together, and verify real custom-agent delegation and MCP behavior,
  not only schema validity. CI runs evals through the same launcher as local
  runs. When you touch the workflows, refresh every action's commit SHA (with
  its version comment), and keep the evals workflow on a Node major that
  `validate.yml` tests.
- Keep remote plugins opt-in. The repository settings overlay must never enable
  a remote plugin; that's a deliberate security rule, so developers install
  remote plugins themselves. A remote entry's `name` must match the upstream
  `plugin.json` name, and its source must pin a full `sha` and should name its
  `ref`. `npm run check-remotes` checks pins against GitHub; it uses the
  network, so keep it out of `verify`. Validate
  catalog metadata without fetching or executing upstream code in checks, and
  document private-repository access. Don't claim the local evals cover remote
  assets.
- Keep secrets and token-bearing URLs out of files. Use host authentication
  for private repositories, not embedded credentials. Never copy private
  organizational code into the examples.
- Do not commit, push, publish, change visibility, or modify GitHub permissions
  unless the user requests it.

## Authoring references

Consult the relevant contract before changing package or catalog fields:

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification).
- [Canonical manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
  and [MCP configuration schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json),
  vendored in [schemas/](schemas/NOTICE).
- [Creating Copilot plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating).
- [Creating a team marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace).
- [CLI plugin and catalog reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).
- [Vally eval schema](https://microsoft.github.io/vally/reference/eval-spec/) and
  [Vally CI guide](https://microsoft.github.io/vally/get-started/add-to-ci/).

The README's [references](README.md#references) cover skills, hooks, VS Code,
and this repository's guides.