# Contributing

Thanks for improving this marketplace. This guide is the checklist for people;
[AGENTS.md](AGENTS.md) adds rules for coding agents, and the [README](README.md)
explains how everything fits together.

Contributions to this project are
[released](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
to the public under the [project's open source license](LICENSE).

Please note that this project is released with a
[Contributor Code of Conduct](CODE_OF_CONDUCT.md). By participating in this
project you agree to abide by its terms.

## Before you start

- Install Node.js 22.14 or newer and run `npm ci`.
- Open an issue with the **New plugin** form before building a new plugin, so
  reviewers can agree on scope and risk first.
- Use only synthetic data in examples, fixtures, and evals. Never commit secrets,
  tokens, or private organizational code.

## Add or change a plugin

Start a new plugin with `npm run new-plugin -- <name>`, optionally with
`--with agent`, `--with mcp`, `--with hook`, `--with extension`, or
`--no-skill`. It creates the files and registrations below, including an eval
that meets the coverage rules, so you only replace the scaffolded content. See
[Add a plugin](README.md#add-a-plugin).

Change these together in one pull request:

1. **Plugin files** under `plugins/<name>/`: `plugin.json`, its skills, agents,
   hooks, MCP server, commands, rules, or extensions, plus `README.md` and
   `CHANGELOG.md`. The root [LICENSE](LICENSE) covers every plugin, so a plugin
   doesn't need its own. Keep it self-contained; never import a sibling
   plugin or this repository's `node_modules` at runtime.
2. **Version**: bump `version` in `plugin.json` and the matching
   [marketplace.json](marketplace.json) entry, and add a `## <version>` heading
   to `CHANGELOG.md`. Any change to a file under `plugins/<name>/` needs a new
   version, because that's what people install. Use a patch version for fixes
   and wording, a minor version for new behavior or options, and a major version
   when existing use breaks. Changes to evals, tests, and docs outside the
   plugin don't need one.
3. **Catalog and settings**: keep the catalog `description` identical to the
   manifest, and enable local plugins in
   [.github/copilot/settings.json](.github/copilot/settings.json). Never enable
   a remote plugin there.
4. **[.vally.yaml](.vally.yaml)**: list the plugin's `skills` directory under
   `paths.skills`, and add any path an eval needs under `params`.
5. **Evals** under `evals/<name>/`: a positive case with invocation and outcome
   assertions for every skill, agent, hook, extension, and MCP tool, a smoke
   case, and a negative control. See [Evals](docs/evals.md#write-an-eval).
6. **Tests** under `test/` for code you add, such as servers, hooks, and graders.
   Name support files after the plugin, such as `test/<name>-hook.test.mjs` and
   `evals/graders/<name>.mjs`, so `npm run remove-plugin` removes them with it.
7. **Related docs**: the plugin's README, and
   <!-- examples -->
   for a shipped example, its section in [Examples](docs/examples.md), and
   <!-- /examples -->
   anything else that describes what you changed. Don't hard-code suite sizes;
   `npm run eval:check` prints them.
8. **Generated files**: if you changed `plugins/*/src/` or `evals/graders/src/`,
   run `npm run build` and commit the regenerated `dist/` files.

Then run:

```sh
npm run build
npm run verify
```

`verify` is model-free and must pass. CI runs it on Linux, Windows, and macOS.
It reports every problem at once as `path: message`, and warns about leftovers
such as mentions of a plugin that no longer exists. The test step takes about a
minute.

For a plugin that's new, or that changes what it can run, read, or reach, fill
in the review table in [Security and data handling](docs/security.md#review-a-plugin)
and paste it into the pull request.

## Remove or rename a plugin

`npm run remove-plugin -- <name>` removes a plugin's directory, evals, catalog
entry, settings entry, and `.vally.yaml` skill path and params, and prunes
Markdown that names it. For a shipped example, `npm run remove-example -- <name>`
also removes the graders, support files, fixtures, and tests that only it uses.
To rename a plugin, change its directory, manifest, catalog entry, settings
key, `.vally.yaml` path, evals, and docs together. `npm run verify` names
anything you missed.

## Remote plugins

A remote catalog entry's `name` must match the upstream `plugin.json` name. It
must pin a full commit `sha`, and should name the `ref` it came from. Document
any access requirement. Local checks never download or run upstream code; run
`npm run check-remotes` to check the pin against GitHub. See
[Remote plugins](docs/remote-plugins.md).

## Paid evals

`npm run eval:smoke`, `npm run eval`, and the **Behavioral evals** workflow run
real Copilot sessions and spend AI credits. Run only the plugins you changed.
`--plugin` selects every spec for a plugin, including nested ones such as
`evals/<name>/agent/eval.yaml`. Check the selection for free, then run and
report on the same selection:

```sh
npm run eval:list -- --plugin <name>
node scripts/evals.mjs eval --plugin <name>
npm run eval:report -- --plugin <name>
```

Repeat `--plugin` for each plugin you changed.

Say in your pull request which evals you ran and what they showed. Inspect a
failed trajectory before changing an assertion, and don't loosen a check just
to get a pass.

## Review

Reviewers look for a clear workflow, honest descriptions, least-privilege tool
lists, hooks that never make permission decisions, MCP servers that start
offline without credentials, and evals that would fail on a wrong outcome.
Report security problems privately as described in [SECURITY.md](SECURITY.md).
