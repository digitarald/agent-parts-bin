# Customization types

A plugin can ship any mix of these. Agent Plugins 1.0 standardizes skills and
MCP servers, so other compatible clients can use them. Everything else is
specific to Copilot and lives under `com.github.copilot/`, which other clients
ignore, except VS Code's automation templates, which live in `automations/`. The [Copilot CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference#components)
lists the official locations.
<!-- examples -->
[Examples](examples.md) shows which example demonstrates each type.
<!-- /examples -->

| Type | Location in a plugin | Use it for | `new-plugin` |
|---|---|---|---|
| Skill | `skills/<name>/SKILL.md`, plus optional `templates/` or `references/` | Procedures and domain knowledge the model loads when a task needs them | Included unless `--no-skill` |
| MCP server | `mcp.json` at the plugin root | Tools backed by code, such as validation or lookups | `--with mcp` |
| Custom agent | `com.github.copilot/agents/<name>.agent.md` | A specialist with its own instructions and tool list | `--with agent` |
| Hook | `com.github.copilot/hooks/hooks.json` | Deterministic commands on events like `postToolUse`. See [Hooks](hooks.md) | `--with hook` |
| Canvas or SDK extension | `com.github.copilot/extensions/<name>/extension.mjs` | Interactive panels and actions | `--with extension` |
| LSP server | `com.github.copilot/lsp.json` | Language intelligence for a file type | By hand |
| Slash command | `com.github.copilot/commands/` | Shortcuts people run by name | Not recommended yet |
| Rules | `com.github.copilot/rules/` | Guidance that ships with an installed plugin | Not recommended yet |
| Automation template | `automations/<name>.automation.md` | A reusable prompt and schedule that VS Code lists under **Templates from Plugins** in the Agents window | By hand |

Automation templates are a VS Code capability, not part of Agent Plugins 1.0,
and they live in `automations/` at the plugin root rather than under
`com.github.copilot/`. Each is Markdown with `version`, `id`, `name`, and
`schedule` frontmatter; the body is the prompt. Installing the plugin doesn't
create or turn on an automation. See VS Code's
[automations in plugins](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference#_automations-in-plugins).
`npm run verify` doesn't check them, and a plugin needs another asset too.

`lsp.json` is checked against the fields in the plugin reference:
`lspServers`, a launch command, and `fileExtensions`. The reference's component
table doesn't list extensions; this repository ships them in
`com.github.copilot/extensions/`.

## Where each type works

Skills and MCP servers are part of the Agent Plugins standard, so other
compatible clients can use them too. Everything else is specific to Copilot,
and support differs by host. In VS Code it also depends on the session's
harness, which you pick with the **Session Target** control: the **Copilot**
harness uses the same runtime as Copilot CLI and the GitHub Copilot app, and
the **Local** harness is VS Code's own.

| Type | Copilot CLI | VS Code, Copilot harness | VS Code, Local harness | GitHub Copilot app |
|---|---|---|---|---|
| Skill | Yes | Yes | Yes | Yes |
| MCP server | Yes | Yes | Yes | Yes |
| Custom agent | Yes | Yes | Yes | Not verified |
| Hook, in this repository's Copilot CLI format | Yes | Yes | Loads, but receives VS Code's own event fields, so a CLI-format script won't find what it expects | Not verified |
| Canvas extension | Not verified | Not verified; VS Code's plugin docs don't list extensions | Not verified | Yes, in the right side panel |
| LSP server | Yes | Not verified | Not verified | Not verified |
| Automation template | Not verified | Listed in the Agents window | Listed in the Agents window | Not verified |

"Not verified" means the official docs this template checked don't say either
way, so test it yourself before you rely on it. Sources: the
[CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference),
the [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference),
VS Code's [agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins),
[plugin reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference),
[hooks](https://code.visualstudio.com/docs/agent-customization/hooks), and
[harnesses](https://code.visualstudio.com/docs/agents/concepts/agent-harnesses)
pages, and the Copilot app's
[canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
page. A skill that drives a canvas should fall back to chat when the host can't
show one.

## Rules and slash commands

The plugin reference names the `commands/` and `rules/` directories but doesn't
document a file format for them, and `copilot plugin install` doesn't report
whether it loaded them. `npm run verify` only checks that those files aren't
empty, so it can't tell you whether a rule works.

Until the reference documents a format, don't ship rules or slash commands.
For company standards, use a skill with `references/` files instead (see
below). It's documented, it works in every client that supports Agent Skills,
and its evals can prove it's used.

## Instruction files and prompt files

Instruction and prompt files belong to a repository, not to a plugin. Copilot
reads them from the project you're working in:

- `.github/copilot-instructions.md` for repository-wide instructions.
- `.github/instructions/**/*.instructions.md`, each with an `applyTo` glob in its
  frontmatter, for instructions that apply only to matching files.
- `AGENTS.md` (Copilot CLI also reads `CLAUDE.md` and `GEMINI.md`) for agent
  instructions in a directory.
- `.github/prompts/*.prompt.md` for reusable prompts in VS Code.

See [adding custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
and [VS Code prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files).

This repository's own [AGENTS.md](../AGENTS.md) and
[.github/copilot-instructions.md](../.github/copilot-instructions.md) guide agents
that maintain this marketplace. Installing a plugin doesn't copy them into
anyone else's project.

## Share guidance across repositories

- Put coding standards and procedures in a skill. Keep `SKILL.md` short and move
  detail into `references/` files the skill reads when it needs them.
- Use a custom agent when the guidance comes with a role and a restricted tool
  list, such as a read-only reviewer.
- If a team still needs a real instruction file in each repository, ship a skill
  that writes or updates it, or keep it in a repository template. A plugin can't
  place files in a consuming repository by itself.
- Prefer a skill over a prompt file or slash command that repeats it. Skills
  load when they're relevant, in any client that supports Agent Skills.

## Add a plugin by hand

`npm run new-plugin` does all of this for skills, agents, MCP servers, hooks,
and canvas extensions. To add another type, or to understand what it did:

1. Create `plugins/<name>/` with `plugin.json`, `README.md`, and `CHANGELOG.md`
   (with a `## <version>` heading). The root [LICENSE](../LICENSE) covers the
   plugin, so it doesn't need its own. The name is lowercase and hyphenated, and
   unique in the catalog.
2. Add assets in the locations above. A skill's `name` matches its directory; an
   agent's `name` matches its file name. MCP servers go in a root `mcp.json` as
   local stdio servers using `${PLUGIN_ROOT}` paths. Hooks run as
   `node "${PLUGIN_ROOT}/<script>"`; see [Hooks](hooks.md).
3. Add an entry to the catalog with a relative `source`, the same `version` and
   `description` as `plugin.json`, and enable `<name>@<marketplace>` in the
   repository overlay.
4. If it has skills, add `plugins/<name>/skills` to `paths.skills` in
   [.vally.yaml](../.vally.yaml) so Vally lints them.
5. Keep the plugin self-contained. Never import a sibling plugin or this
   repository's `node_modules` at runtime. If an MCP server needs dependencies,
   write it as `src/server.ts`. [scripts/build.mjs](../scripts/build.mjs) finds
   every `plugins/*/src/server.ts` and bundles it into `dist/server.mjs` with its
   license notices, replacing `__PLUGIN_VERSION__` with the version in
   `plugin.json`. Eval graders in `evals/graders/src/` are bundled the same way.
   Run `npm run build` after changing those sources and commit the output.
6. In-repo MCP servers must start offline, without credentials, network access,
   or a database. `npm run verify` starts each one to read its tool list for
   eval coverage. Put anything that needs a secret behind a tool call.
7. Add evals under `evals/<name>/` (see [Evals](evals.md)) and focused tests
   under `test/` for code such as servers, hooks, and graders. If an eval needs
   a path, such as your server bundle, add it to `params` in `.vally.yaml`.
   Name support files after the plugin so `npm run remove-plugin` removes them
   with it: `evals/graders/<name>.mjs` or `<name>-*.mjs` (also under
   `evals/graders/src/` for a bundled grader), `evals/support/<name>-*`,
   `evals/fixtures/<name>/`, and `test/<name>.test.mjs` or `test/<name>-*.test.mjs`.
   A file named anything else stays behind when the plugin goes.
8. Run `npm run verify`.

For every release, change the version in `plugin.json`, the catalog, and the
changelog together.
