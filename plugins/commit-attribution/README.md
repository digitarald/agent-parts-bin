# Commit attribution

Attribute Copilot commits to their sessions with a commit skill and Git hook enforcement.

| Skill | Use when |
|---|---|
| `commit` | Creating a commit or retrying one rejected for missing attribution |

Requires Git and Node.js with native TypeScript support (Node.js 22.18+). Targets the shared Copilot runtime in VS Code and CLI, with Bash and PowerShell command adapters.

Install from Agent Parts Bin after reviewing the persistent Git configuration changes below:

```sh
copilot plugin marketplace add digitarald/agent-parts-bin
copilot plugin install commit-attribution@agent-parts-bin
```

## How it works

On session start, the plugin installs a persistent dispatcher in Git metadata and sets repository-local `core.hooksPath`. Existing hooks run first from their original directory, including custom hook paths. No tracked hook files are changed. Installation is checked again before shell commands.

Each agent shell command gets its own attribution environment. The Git `commit-msg` hook reads the actual message, including messages from files, stdin, or child scripts. It rejects a missing Copilot co-author trailer and adds missing session/model metadata:

```text
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
Copilot-Session-Id: <runtime-session-id>
Copilot-Model: <verified-issuing-model>
```

Already-valid attribution passes unchanged, including previous session/model values during amendments or cherry-picks. The model is optional when unavailable; the hook reports that explicitly. It identifies the model issuing the command, not every model that contributed code. Historical provenance is preserved, not re-verified.

Rejections reach the agent, which should fix the message and retry. The skill prohibits bypasses. The plugin never automatically amends, resets, or pushes. Commands outside the agent have no attribution context and retain their original hook behavior.

The dispatcher and its dependency-free Git validator stay installed after a session ends, independently of the plugin cache. All plugin runtime code uses Node.js built-ins, so it needs neither `node_modules` nor the repository's dependency bootstrap. Git hooks do not install packages. Previous hook configuration is saved in `copilot-commit-attribution/state.json` under the Git common directory. For manual removal, restore its `previousLocalPath` as the local `core.hooksPath`, or unset the local key if that value is `null`. Only then remove the plugin-owned directory.

## Managed enforcement or optional tracking

For organizational enforcement, require this plugin through [enterprise-managed settings](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings), alongside your approved marketplace configuration:

```json
{
  "enabledPlugins": {
    "commit-attribution@agent-parts-bin": true
  }
}
```

If your organization permits only managed hooks, ensure this plugin is force-enabled through that policy. Voluntary installation is useful for teams that simply want session tracking, but users can disable it. Managed deployment ensures availability, not tamper-proof Git enforcement.

[OpenTelemetry monitoring](https://code.visualstudio.com/docs/agents/guides/monitoring-agents) is another correlation route. It exports commit SHA, conversation/session identifiers, and model metadata to your configured collector. The current-commit attribute is repository context, not a receipt for every new commit. This plugin adds no telemetry exporter.

## Host checks

The Copilot CLI marketplace-installation smoke test passed on macOS with version 1.0.1 before this move. It verified skill discovery, automatic hook installation, rejected commits, stored session/model trailers, and unchanged human commits. PowerShell command adapters were tested on macOS, not Windows. VS Code activation is not verified: the previous test session did not discover the plugin.

After installation, try it in a disposable repository:

1. Initialize a repository, configure a test Git identity, install/enable the plugin, and start a Copilot session there.
2. Ask the agent to commit an empty test change with a message that omits attribution. The hook should refuse it and leave HEAD unchanged.
3. Use the `commit` skill to retry. Check the stored message with `git log -1 --format=%B`.
4. Repeat with `git commit -F <message-file>` or stdin. The same guard should apply.
5. Commit from a separate human terminal. No Copilot metadata should be added. Existing valid session/model trailers should also survive a requested amendment or cherry-pick.

## Limits

- This is a proof of concept, not a security boundary. `--no-verify`, hook-path overrides, disabled plugins, and Git plumbing can bypass it. Deterministic bypass hardening is deferred.
- Command-hook timeouts fall through to normal permissions. Other repository integrations that replace `core.hooksPath` require reconciliation; failures are reported rather than silently overwriting their configuration.
- Context is set and restored inside the original shell, preserving ordinary directory/variable changes and exit status. Background child processes inherit their own copy.
- Only configured workspace repositories and tested worktrees are covered. Creating/cloning and committing in another repository inside one command is not covered.
- Model lookup reads only a bounded tail of the current session's event log under `COPILOT_HOME` (default `~/.copilot`). Inaccessible, ambiguous, or unresolved model data is reported as unavailable. Session IDs alone do not grant access to retained transcripts.
- PowerShell/Windows requires a native validation run before claiming verified support; Bash tests on macOS do not establish Windows behavior.

## Plugin structure

```text
commit-attribution/
  plugin.json
  CHANGELOG.md
  skills/commit/SKILL.md
  com.github.copilot/hooks/hooks.json
  scripts/
    attribution.mts
    attribution-impl.mts
    git-hook.mjs
```

Model-free tests live in `../../test/commit-attribution.test.mts`. Run them from the marketplace root with `node --test test/commit-attribution.test.mts`.
