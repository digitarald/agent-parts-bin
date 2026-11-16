# Local development

## Work in this checkout

Opening this checkout in a trusted Copilot CLI session enables its local
plugins from the working files. The repository overlay,
[.github/copilot/settings.json](../.github/copilot/settings.json), declares
this directory as a marketplace. Remote entries remain opt-in.

```sh
npm ci
npm run verify
copilot
```

Accept the folder-trust prompt for this checkout. The CLI ignores an untrusted
checkout's repository settings, so if the plugins are missing, check folder
trust first. Review the local plugins before trusting the checkout. Don't
install the plugins globally just to make local discovery work. Host trust
prompts and managed policy still apply.

To try an experiment here or in another project, pass its absolute local path:

```sh
copilot --plugin-dir /absolute/path/to/plugins/<name>
```

## Work in VS Code

VS Code runs plugins in its chat and Agents window. What a plugin can do there
depends on the session's harness, which you pick with the **Session Target**
control:

- The **Copilot** harness uses the same runtime as Copilot CLI and the GitHub
  Copilot app, so skills, agents, MCP servers, and hooks in the Copilot CLI
  format behave as they do in the CLI.
- The **Local** harness is VS Code's own. It runs skills, agents, and MCP
  servers, but it sends hooks a different event, so a hook written for the Copilot CLI
  format can't do its job there.

[Where each type works](customization-types.md#where-each-type-works) has the
full table, with the sources.

To test a plugin you haven't pushed yet, register its folder with the
`chat.pluginLocations` setting, which VS Code marks Experimental:

```json
"chat.pluginLocations": {
  "/absolute/path/to/your-marketplace/plugins/release-notes": true
}
```

Then start a new chat, confirm the plugin's skills appear in
**Chat: Configure Skills**, and run a task that uses it. See
[use local plugins](https://code.visualstudio.com/docs/agent-customization/agent-plugins#_use-local-plugins).
VS Code reads this repository's overlay as
[workspace plugin recommendations](https://code.visualstudio.com/docs/agent-customization/agent-plugins#_workspace-plugin-recommendations)
and offers the listed plugins; whether it accepts the overlay's local-directory
marketplace source isn't verified here. VS Code also picks up plugins you
install with Copilot CLI. Make sure agent plugins are turned on with
`chat.plugins.enabled`.

The model-free checks, `npm run verify`, the eval tooling, and the
installation test below all use Node.js and the pinned Copilot CLI from
`npm ci`, so even a VS Code-first author needs the terminal for those.

## Test installation without publishing

`npm run verify` checks installation in `test/installation.test.mjs`. It copies
the local plugins into an owned temporary directory and uses a separate Copilot
home. It does not install into your real profile or start a model session.
For another contributor's branch, review its code before running its checks.
Installation is separate from the simpler `--plugin-dir` development workflow.

What this does and doesn't prove:

- A local path is registered live: Copilot reads the plugin from your checkout,
  and nothing is copied. Only an install from your GitHub repository proves the
  published layout, so test that before you share it: push, then
  `copilot plugin marketplace add OWNER/REPO` in a fresh isolated home.
- Installation alone doesn't prove that a hook fires, an
  MCP server starts, or a canvas renders. The install message counts skills
  only; a plugin whose `hooks.json` or extension has a mistake looks the same
  as one that works. Model-free tests cover only their asserted behavior; check
  the hosts you support by hand too, as described below.
- Remote plugins can't be tested this way. Copilot treats every plugin in a
  local-directory marketplace as a live local folder, so it removes a
  downloaded remote plugin on the next command. See
  [Test a remote entry](remote-plugins.md#test-a-remote-entry).

## Pinned Copilot CLI

The repository pins `@github/copilot` in `package.json`, and the eval tooling
uses that version. Copilot CLI's auto-update downloads newer releases into a
package cache and launches the newest one, so outside CI the pinned package can
report a later version. Set `COPILOT_AUTO_UPDATE=false` to run the
pinned binary. The eval runtime bridge does this for you, and
`node .github/scripts/eval-runtime.js --version` prints both the pinned package version
and the version that runs.

## Troubleshooting

- **`npm run verify` says dependencies aren't installed.** Run `npm ci` first.
- **`npm test` seems slow.** The adoption and installation tests copy the
  repository and install every plugin into temporary Copilot homes, so the test
  step takes about a minute.
- **A test fails with `MCP error -32001: Request timed out`.** A test process
  that starts a real MCP server didn't answer in time, usually because the
  machine was busy. The tests allow up to 30 seconds; run the failing file
  alone, for example `node --test test/canvas-host.test.mjs`, to
  confirm it passes, and report it if it keeps failing.

## Before a release

- Open the trusted checkout and confirm its local plugins are enabled.
  Check each plugin's skills and agents.
- Install from your GitHub repository in a separate test environment and
  confirm the same plugins.
- Run through each plugin's `## Host checks` in its README, in every host you
  support. `npm run new-plugin` writes that section for you, and
  `npm run verify` warns about a plugin README without one.

Automated tests and evals don't replace these checks. For each type, check:

- **Skills:** a request that should use the skill does, and an unrelated one
  doesn't.
- **Custom agents:** the agent is listed, can be selected or delegated to, and
  uses only the tools it lists.
- **MCP servers:** the server starts, its tools are listed, and a call returns
  the expected result. Check it in every host your team uses.
- **Hooks:** a single edit, a multi-file edit, and `apply_patch` each trigger
  it; a failed edit and an unrelated tool don't; its message appears in the
  conversation. In VS Code, check both the Copilot and Local harnesses if
  people use both.
- **Canvases:** the panel opens; a change from the agent shows in the panel and
  a change in the panel is visible to the agent; keyboard focus survives an
  update; closing and reopening the panel keeps the session's state; a new
  session starts empty; and in a host without canvases, the skill falls back
  to chat. In VS Code, also check what happens after **Developer: Reload
  Window**.
