# Plugin marketplace starter

A GitHub template for building, evaluating, and sharing AI customizations
(skills, custom agents, hooks, MCP servers, and more) as an
[Agent Plugins](https://agent-plugins.org/) marketplace for GitHub Copilot. It
works for a team in an organization and for one person with a personal
account.

<!-- template-only -->
**Status:** active development. GitHub maintains this template; see
[Maintainers](#maintainers) and [Support](#support).
<!-- /template-only -->

It gives you:

<!-- examples -->
- Six small example plugins to learn from, copy, or delete.
<!-- /examples -->
- Commands that scaffold a plugin, remove one, and rename the marketplace.
- `npm run verify`, a model-free check of manifests, the catalog, tests, and
  eval coverage, which CI runs on every pull request.
- Behavioral evals for every skill, agent, hook, extension, and MCP tool, run
  with [Vally](https://microsoft.github.io/vally/), the eval runner and linter
  pinned in `package.json`. Evals run real Copilot sessions and cost AI
  credits, so they're opt-in in CI.

Two terms come up a lot:

- The **catalog** is [marketplace.json](marketplace.json). It names the
  marketplace and lists its plugins.
- The **repository overlay** is
  [.github/copilot/settings.json](.github/copilot/settings.json). It makes
  Copilot load this checkout's plugins while you work in it, without a global
  install.

<!-- plugin-table -->
| Plugin | Try it | Teaches |
|---|---|---|
| [bug-report](plugins/bug-report/) | "Turn these notes into a bug report" | A basic skill that loads the right template on demand |
| [format-json](plugins/format-json/) | Ask Copilot to edit a JSON file | A post-tool hook that formats the files an edit touched |
| [team-brainstorm](plugins/team-brainstorm/) | "Let's brainstorm a release plan together" | A skill with a canvas extension and a shared session-only UI |
| [customization-authoring](plugins/customization-authoring/) | "Create a skill and evals for summarizing a changelog" | A skill that writes a skill and its evals |
| [code-review](plugins/code-review/) | "Use adversarial-review to review this diff without changing it" | A skill that delegates to a read-only custom agent |
| [json-configuration](plugins/json-configuration/) | 'Use json-configuration to validate {"port":8443} and look up /port' | A skill backed by a bundled local MCP server |

<!-- examples -->
[Examples](docs/examples.md) explains what each example shows and which files
it owns.
<!-- /examples -->

<!-- template-only -->
## Background

Most shared Copilot customizations ship as loose files, without a catalog,
checks, or evals, because teams have to piece that setup together from docs.
This template puts the whole setup in one repository, so a new skill, agent,
hook, or MCP server arrives with a catalog entry, a model-free check, and an
eval that shows it works.

Planned work and known gaps are in the
[open issues](https://github.com/github/plugin-marketplace-starter/issues).
Contributions are welcome, from fixes to the scripts and docs to better
examples and new checks. Read [CONTRIBUTING.md](CONTRIBUTING.md) first.
<!-- /template-only -->

## Requirements

- To install and use the plugins: a current Copilot CLI, the GitHub Copilot
  app, or VS Code with agent plugins turned on, and a GitHub Copilot plan. See
  [Install plugins](#install-plugins).
- To build, check, and change the marketplace: Node.js 22.14 or newer and npm.
  `npm ci` installs everything else, including the pinned Vally CLI and Copilot
  runtime that evals use.
- To run behavioral evals: a Copilot plan or organization policy that allows
  the usage, since every run spends AI credits. See [Evals](#evals).

## Make it yours

You need Node.js 22.14 or newer.

1. Click **Use this template** on GitHub, clone your new repository, and run
   `npm ci`.
2. Rename the marketplace. This changes the catalog, the repository overlay,
   `package.json`, and the install commands and placeholders in every README
   at once:

   ```sh
   npm run rename-marketplace -- --name my-team-plugins --owner "My Team" --repo my-org/my-team-plugins
   ```

   The name must be unique, lowercase, and hyphenated. Add `--dry-run` to see
   which files would change.
   <!-- examples -->
3. Remove the shipped examples you don't want with
   `npm run remove-example -- <name>...`, or all of them with
   `npm run remove-example -- --all`. See
   [Remove a plugin](#remove-a-plugin). You can do this before or after you
   add your own plugins.
   <!-- /examples -->
4. Add your first plugin with `npm run new-plugin -- <name>`. See
   [Add a plugin](#add-a-plugin). `npm run verify` passes even with no plugins
   at all.
5. Replace what's meant for you before you ship:
   - Your own copyright line in [LICENSE](LICENSE), beside the template's. That
     one file covers the whole repository, including every plugin. See
     [Licensing](#licensing).
   - The title and introduction of this README.
   - Real owners in [.github/CODEOWNERS](.github/CODEOWNERS). On a personal
     account, that can be just you.
   - Your reporting channel in [SECURITY.md](SECURITY.md).
   - Your process in [CONTRIBUTING.md](CONTRIBUTING.md), the
     [pull request template](.github/PULL_REQUEST_TEMPLATE.md), and the
     [new plugin issue form](.github/ISSUE_TEMPLATE/new-plugin.yml).
   - Your maintenance rules in
     [.github/copilot-instructions.md](.github/copilot-instructions.md) and
     [AGENTS.md](AGENTS.md).
6. Run `npm run verify`. It fails on anything inconsistent and warns about
   leftovers, such as the template's name or introduction, a `LICENSE` that
   doesn't name you yet, scaffold text you haven't replaced, or a mention of a
   plugin you removed.
7. Push, then turn on branch protection or a ruleset for your default branch.
   Rulesets are available for public repositories on every plan. Behavioral
   evals stay off in CI until you turn them on; see
   [Continuous integration](#continuous-integration).
8. [Test installation](docs/local-development.md#test-installation-without-publishing)
   locally, then from your GitHub repository, before you share it.

For agent-assisted setup and maintenance, see [AGENTS.md](AGENTS.md).

## Install plugins

Use a current Copilot CLI, the GitHub Copilot app, or VS Code. Installed
plugins don't need `npm` or this repository's dependencies. Review a plugin
before you trust it: hooks and MCP servers run code on your machine. Not every
type works in every host; see
[where each type works](docs/customization-types.md#where-each-type-works).

### Copilot CLI

```sh
copilot plugin marketplace add github/plugin-marketplace-starter
copilot plugin marketplace browse plugin-marketplace-starter
copilot plugin install bug-report@plugin-marketplace-starter
copilot plugin install team-brainstorm@plugin-marketplace-starter
copilot plugin install format-json@plugin-marketplace-starter
copilot plugin install customization-authoring@plugin-marketplace-starter
copilot plugin install code-review@plugin-marketplace-starter
copilot plugin install json-configuration@plugin-marketplace-starter
```

Choose only the plugins you need; each one installs on its own. Start a new
session after installing.

### VS Code

Run **Chat: Install Plugin from Source** and enter the repository, here
`github/plugin-marketplace-starter`, or add it to `chat.plugins.marketplaces`.
Make sure agent plugins are turned on with `chat.plugins.enabled`, and start a
new chat. Hooks in this repository's format run in sessions that use the
**Copilot** harness, which shares Copilot CLI's runtime, and not in the
**Local** harness. To try a plugin you haven't pushed yet, see
[Work in VS Code](docs/local-development.md#work-in-vs-code).

Skills and MCP servers also work in other clients that support Agent Plugins.

## Add a plugin

```sh
npm run new-plugin -- release-notes
npm run new-plugin -- sql-helper --with mcp --with agent --description "Review SQL migrations."
npm run new-plugin -- lint-on-save --no-skill --with hook
npm run new-plugin -- team-standup --with extension
npm run verify
```

`new-plugin` creates `plugins/<name>/` with `plugin.json`, a skill, a README
with Install and Host checks sections, and a CHANGELOG, plus
`evals/<name>/eval.yaml` with cases that already meet the coverage rules. It
adds the plugin to the catalog, the repository overlay, `.vally.yaml`, and this
README's plugin table and install commands.

- `--with agent` adds a read-only custom agent and a delegation eval.
- `--with mcp` adds a local MCP server in `src/server.ts` with one example
  tool, and builds it.
- `--with hook` adds a `postToolUse` hook, a model-free test for it, and an eval
  that proves it ran. See [Hooks](docs/hooks.md).
- `--with extension` adds a canvas extension, an eval through the shared
  headless canvas host, and its grader.
- `--no-skill` leaves out the skill, for a plugin such as a hook on its own.

Then replace the scaffolded instructions, README, and eval prompts with your
real ones, and run `npm run verify`. It warns until the scaffold text is gone.
Group a plugin by workflow, not by asset type: a skill and the agent or MCP
server it uses belong together.

To add other types, such as LSP servers, or to set a plugin up by hand, see
[Customization types](docs/customization-types.md). Run `npm run build` only
when you change a plugin's `src/` or `evals/graders/src/`; it regenerates the
committed bundles.

## Remove a plugin

```sh
npm run remove-example -- --all
npm run remove-plugin -- release-notes
npm run verify
```

`remove-plugin` deletes `plugins/<name>/` and `evals/<name>/`, its catalog
entry, its repository overlay key, its `.vally.yaml` skill path and params, and
support files named after it, such as `evals/graders/<name>.mjs` and
`test/<name>-*.test.mjs`. For a remote plugin, it removes the catalog entry.
For a shipped example, `remove-example` also deletes the graders, eval support
files, fixtures, and tests that only that example uses, and the last one takes
the examples guide with it. Both commands remove install commands, table rows,
and marked sections in Markdown that name the plugin, and turn other links to
its files into plain text. A table that loses every row gets a "None yet" row.
Use `--dry-run` to see what would go. `npm run verify` warns about any prose
that still mentions a removed plugin.

## Evals

`npm run verify` is model-free. It also checks eval coverage: every local
skill, agent, hook, extension, and MCP tool needs a positive case that asserts
it ran and what it did, a case in the `smoke` suite, and a negative case with an
observable assertion. `npm run new-plugin` writes evals that pass, and
[Write an eval, step by step](docs/eval-authoring.md) explains each part of
one. [Evals](docs/evals.md) covers agents, MCP tools, hooks, extensions,
suites, and results.

Running evals costs AI credits. List what a run would select first; that's
free:

```sh
npm run eval:list -- --suite smoke
npm run eval:smoke
npm run eval:report -- --suite smoke
```

To run only the plugins you changed, use `--plugin <name>`; see
[Run only the plugins you changed](docs/evals.md#run-only-the-plugins-you-changed).

## Continuous integration

[validate.yml](.github/workflows/validate.yml) runs `npm run verify` on Linux,
Windows, and macOS with Node.js 22 and 24 for every pull request and every push
to `main`. It never calls a model, and on its own it's enough to keep the
marketplace consistent.

[evals.yml](.github/workflows/evals.yml) runs behavioral evals. It's off for
pull requests until you set the repository variable `ENABLE_EVALS` to `true`,
and you can always run it by hand. Each run can wait for a reviewer's approval
through the `evals` environment. It runs the same launcher you use locally,
with the pinned Vally CLI. On a personal account, usage is billed to your own
Copilot plan. [Continuous integration](docs/ci.md) covers
setup, personal accounts, billing, cost, and security.

## Repository layout

```text
marketplace.json           # The catalog: marketplace name, owner, and plugins
plugins/<name>/            # One self-contained plugin per workflow
  plugin.json, README.md, CHANGELOG.md
  skills/<skill>/SKILL.md
  com.github.copilot/      # Copilot-only parts: agents, hooks, extensions, and more
  mcp.json, src/, dist/    # A local MCP server, its source, and its bundle
evals/<name>/eval.yaml     # Behavioral evals, kept outside the plugins
evals/graders/, support/, fixtures/
.vally.yaml                # Skill paths, eval file names, params, and suites
scripts/                   # verify, build, new-plugin, remove-plugin, rename, eval launcher
test/                      # Model-free tests
schemas/                   # Vendored Agent Plugins schemas (Apache-2.0)
docs/                      # Reference guides
.github/copilot/           # The repository overlay
.github/workflows/         # validate.yml and evals.yml
```

## Licensing

The repository is [MIT licensed](LICENSE). That one root `LICENSE`, held by
GitHub, Inc., covers everything here: the scripts, tests, docs, and every
plugin. Plugins don't carry their own `LICENSE`; each one declares
`"license": "MIT"` in its `plugin.json`.

Two different names show up, and they mean different things.
`owner.name` in [marketplace.json](marketplace.json), `GitHub` in the template,
says who publishes the catalog. `npm run rename-marketplace` sets it to you.
The `Copyright` line in `LICENSE` says who holds the copyright in the code.

- MIT asks that its copyright and permission notice stay with every copy, so
  keep the `Copyright (c) 2026 GitHub, Inc.` line for the code you kept from
  the template. Add your own `Copyright` line below it. It covers your changes
  and the plugins you write.
- `npm run verify` warns, once you've renamed the marketplace, while the root
  `LICENSE` names only GitHub, Inc. It doesn't warn when the catalog owner is
  `GitHub`.
- To use a different license, change the root `LICENSE`, `license` in
  `package.json`, and each plugin's `plugin.json` `license`. `verify` doesn't
  check that they agree. Code you kept from the template stays under MIT, with
  its notice.
- If one plugin needs a different license from the rest, give it its own
  `LICENSE` and set its `plugin.json` `license` to match.
- Keep the vendored Agent Plugins schemas' Apache-2.0
  [license](schemas/LICENSE-APACHE-2.0.txt) and [notice](schemas/NOTICE), and
  the third-party notices beside each generated bundle.

<!-- template-only -->
## Maintainers

GitHub's Copilot Evals team, `@github/code-ai-evals`, maintains this template.
[.github/CODEOWNERS](.github/CODEOWNERS) lists the code owners who review
changes.

## Support

See [SUPPORT.md](SUPPORT.md) for how to ask questions and report bugs, and
[SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

## Acknowledgement

This template builds on the [Agent Plugins](https://agent-plugins.org/)
standard and its schemas, and runs its evals with
[Vally](https://microsoft.github.io/vally/). Thanks to
[@digitarald](https://github.com/digitarald), who wrote its first version, and
to everyone who's contributed since.
<!-- /template-only -->

## References

- [Customization types](docs/customization-types.md), [Hooks](docs/hooks.md),
  [Evals](docs/evals.md), [Write an eval](docs/eval-authoring.md),
  [Continuous integration](docs/ci.md),
  [Local development](docs/local-development.md),
  [Remote plugins](docs/remote-plugins.md), and
  [Security and data handling](docs/security.md)
<!-- examples -->
- [Examples](docs/examples.md)
<!-- /examples -->
- [Agent Plugins standard](https://agent-plugins.org/)
- [GitHub Copilot plugins](https://docs.github.com/en/copilot/concepts/agents/about-plugins)
- [Creating a team marketplace](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-marketplace)
- [CLI plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference)
- [Hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [VS Code agent plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins)
- [Agent Skills specification](https://agentskills.io/specification)
- [Vally](https://microsoft.github.io/vally/), its
  [eval schema](https://microsoft.github.io/vally/reference/eval-spec/), and
  [CI guide](https://microsoft.github.io/vally/get-started/add-to-ci/)
