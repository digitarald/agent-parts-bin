# Agent Parts Bin

Rough agent-plugin experiments. No promises.

This is where I put ideas before I know whether they're any good. Plugins may
be broken, misleading, or unsafe. They may change or disappear without notice.
Nothing here is a recommendation to use it.

Hooks, MCP servers, and extensions can execute code with your permissions.
Read the source before enabling anything. Try experiments in a disposable
environment without secrets, credentials, or important files. Don't give them
access to production systems.

Looking for plugins I actually rely on? Try
[Agent Toolbelt](https://github.com/digitarald/agent-toolbelt).

## Plugins

<!-- plugin-table -->
| Plugin | Try it | Purpose |
|---|---|---|
| [session-todos](plugins/session-todos/) | "Open Session Todos" | Read-only live plan monitor with dependencies and recent changes. |
| [decide](plugins/decide/) | "Use the decide skill to help with my task" | Typed decisions for bounded classification, routing, and scoring through a user-configured Microsoft Foundry deployment. |
| [session-lens](plugins/session-lens/) | "Show my Copilot activity today" | Explore Copilot activity, model roles, skill invocations, and MCP usage across dates and sessions. |
| [commit-attribution](plugins/commit-attribution/) | "Use the commit skill to commit my changes with attribution" | Requires Copilot attribution and records session/model trailers. Automatically installs a persistent Git hook dispatcher. |

Template plugins stay removed. Updates from the
[upstream template](https://github.com/github/plugin-marketplace-starter)
apply to infrastructure, not the plugin catalog. Session Lens includes a
[product spec](plugins/session-lens/PRODUCT.md) and a local inspection canvas.

### External plugins

These are opt-in, SHA-pinned references to separate repositories. This
marketplace's tests do not cover their behavior.

| Plugin | Try it | Purpose |
|---|---|---|
| [Agent Reproach](https://github.com/digitarald/agent-reproach) | "Read the feedback and open the Agent Reproach inbox" | Local agent feedback tools and a compact review canvas. |

Agent Reproach is public, MIT-licensed, and prebuilt. It requires Node.js 20+
and a host that supplies `PLUGIN_DATA` to plugin MCPs; the graphical inbox also
requires canvas support. It reads optional session metadata from a supplied
session directory and writes reports and triage state locally. It makes no
external network requests; choosing to investigate a report sends it into the
current agent workflow. Reports and paths can contain sensitive information.
Proactive reporting and compatibility across hosts are experimental.

The repository overlay does **not** enable it. After reviewing the source:

```sh
copilot plugin install agent-reproach@agent-parts-bin
```

Don't enable it alongside another Agent Reproach installation. See the
[upstream storage and privacy notes](https://github.com/digitarald/agent-reproach#storage-and-privacy)
and [remote plugin guide](docs/remote-plugins.md).

## Install plugins

If you're comfortable with those risks, add the marketplace in Copilot CLI:

```sh
copilot plugin marketplace add digitarald/agent-parts-bin
copilot plugin marketplace browse agent-parts-bin
copilot plugin install decide@agent-parts-bin
copilot plugin install session-lens@agent-parts-bin
copilot plugin install session-todos@agent-parts-bin
copilot plugin install commit-attribution@agent-parts-bin
```

Once plugins are listed, install only an experiment you've reviewed with
`copilot plugin install <plugin-name>@agent-parts-bin`, then start a new session.

In VS Code, run **Chat: Install Plugin from Source** and enter
`digitarald/agent-parts-bin`, or add it to `chat.plugins.marketplaces`.
Enable `chat.plugins.enabled` and start a new chat.
See [host support](docs/customization-types.md#where-each-type-works).

In supported hosts, trusting this checkout enables its local plugins through
the repository overlay. Remote plugins remain opt-in. Review local code before
trusting the checkout. Use `--plugin-dir` to try a selected local plugin.
See [Security](SECURITY.md) and [Local development](docs/local-development.md).

## Requirements

Using plugins requires a current Copilot CLI, the GitHub Copilot app, or
VS Code with agent plugins enabled, and a GitHub Copilot plan.
Maintaining this repository requires Node.js 22.15 or newer (24+ recommended),
npm, and Git 2.28 or newer.

```sh
npm ci
npm run verify
```

## Add a plugin

Create `plugins/<name>/` with a manifest, README,
and changelog, then add its matching catalog entry, README row, and install
command. Register its skills in `.vally.yaml` and enable it in the
repository overlay for development. See [Contributing](CONTRIBUTING.md).

The retained `npm run new-plugin -- my-experiment` command also scaffolds
components with `--with agent`, `mcp`, `hook`, or `extension`. Its generated
evals are optional. Document what the plugin can run, read, write, and reach,
including known failures. Run `npm run verify`.

Changes since a known released base need a version bump in the manifest and
catalog and a matching changelog entry. An unreleased first version keeps its
initial version. Don't infer release status from a PR base or bump twice.

## Remove a plugin

```sh
npm run remove-plugin -- my-experiment
npm run verify
```

Keep the catalog, repository overlay, docs, and optional eval references in step,
including references from other plugins' evals.

## Evals

No behavioral evals are required or promised here.
`npm run verify` runs type and manifest checks, generated-file checks, and
model-free tests. It deliberately omits the template's eval-coverage and
eval-lint gates. Passing CI means the repository is structurally consistent,
not that an experiment works or is safe.

The [commit-attribution smoke eval](evals/commit-attribution/skills/commit/commit.eval.yaml)
checks message drafting and skill routing. The separate
[extended eval](evals/commit-attribution/skills/commit/git-extended.eval.yaml)
checks commits, rejected-message recovery, and amendments using the real Git
hook with synthetic runtime context. Both are statically validated, not yet run;
neither verifies automatic host integration or rollout reliability.
The optional eval tooling and [eval guide](docs/evals.md) remain available for
experiments that might graduate to Toolbelt. Running behavioral evals costs
AI credits and requires an explicit request. Vally 0.21 uses the local backend,
not a sandbox. Review the [checks and scoped authentication guide](docs/checks-and-evals.md)
before running anything paid.

Saved-run reports now include scores, token counts, duration, and baseline
comparisons. The optional two-model experiment can preview and run your evals
once you add them. Neither tool establishes quality.

## Continuous integration

Model-free verification runs on pull requests and pushes to `main`.
Paid behavioral evals are manual-only; pull requests never start them.
See [CI setup](docs/ci.md).

## Licensing

[MIT](LICENSE). The original template's copyright notice is preserved.
The root license covers the repository and its plugins.

## References

- [Contributing and versioning](CONTRIBUTING.md)
- [Local development and host checks](docs/local-development.md)
- [Checks, authentication, and saved results](docs/checks-and-evals.md)
- [Optional evals](docs/evals.md)
- [Writing evals](docs/eval-authoring.md)
- [CI setup](docs/ci.md)
- [Hook contracts](docs/hooks.md)
- [Customization types](docs/customization-types.md)
- [Security and data handling](docs/security.md)
- [Remote plugins](docs/remote-plugins.md)
- [Agent Plugins standard](https://agent-plugins.org/)
- [Agent Toolbelt](https://github.com/digitarald/agent-toolbelt)
