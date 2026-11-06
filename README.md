# Agent Parts Bin

Rough agent-plugin experiments. No evals. No promises.

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
| None yet | | |
| [decide](plugins/decide/) | "Use the decide skill to help with my task" | Typed decisions for bounded classification, routing, and scoring through a user-configured Microsoft Foundry deployment. |

The starter's demo plugins have been removed. Decide is the first experiment;
it has offline CLI tests, not behavioral evals or accuracy guarantees.

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
```

Once plugins are listed, install only an experiment you've reviewed with
`copilot plugin install <plugin-name>@agent-parts-bin`, then start a new session.

In VS Code, run **Chat: Install Plugin from Source** and enter
`digitarald/agent-parts-bin`, or add it to `chat.plugins.marketplaces`.
Enable `chat.plugins.enabled` and start a new chat.
See [host support](docs/customization-types.md#where-each-type-works).

Trusting this checkout in Copilot CLI enables every local plugin through the
repository overlay. Don't trust the folder unless you'd enable all of them.
See [Security](SECURITY.md) and [Local development](docs/local-development.md).

## Requirements

Using plugins requires a current Copilot CLI, the GitHub Copilot app, or
VS Code with agent plugins enabled, and a GitHub Copilot plan.
Maintaining this repository requires Node.js 22.14 or newer and npm.

```sh
npm ci
npm run verify
```

## Add a plugin

```sh
npm run new-plugin -- my-experiment
npm run verify
```

Use `--with agent`, `--with mcp`, `--with hook`, or `--with extension` for
other components, and `--no-skill` for a plugin without a skill.
Replace the scaffold with the experiment and document what it can run,
read, write, and reach. Describe known failures without claiming reliability.

The inherited scaffold also creates eval files. Keeping or developing those
is optional here; they are not a publishing requirement or proof of quality.
See [Contributing](CONTRIBUTING.md).

## Remove a plugin

```sh
npm run remove-plugin -- my-experiment
npm run verify
```

Use the scripts to keep the catalog, repository overlay, docs, and any eval
registrations consistent.

## Evals

No behavioral evals are required or promised here.
`npm run verify` runs type and manifest checks, generated-file checks, and
model-free tests. It deliberately omits the template's eval-coverage and
eval-lint gates. Passing CI means the repository is structurally consistent,
not that an experiment works or is safe.

The optional eval tooling and [eval guide](docs/evals.md) remain available for
experiments that might graduate to Toolbelt. Running behavioral evals costs
AI credits and requires an explicit request.

## Continuous integration

Model-free verification runs on pull requests and pushes to `main`.
Paid behavioral evals remain opt-in, with pull-request runs disabled unless
`ENABLE_EVALS` is set to `true`. No behavioral evals have been run as part of
this repository's initialization.
See [CI setup](docs/ci.md).

## Licensing

[MIT](LICENSE). The original template's copyright notice is preserved.
The root license covers the repository and its plugins.

## References

- [Customization types](docs/customization-types.md)
- [Security and data handling](docs/security.md)
- [Remote plugins](docs/remote-plugins.md)
- [Agent Plugins standard](https://agent-plugins.org/)
- [Agent Toolbelt](https://github.com/digitarald/agent-toolbelt)
