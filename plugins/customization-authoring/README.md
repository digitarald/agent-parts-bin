# Customization authoring

One portable skill that turns a repeatable task into a focused `SKILL.md` and a
Vally eval with a real task case and a non-trigger case. No hooks, agents, MCP
servers, or runtime dependencies.

| Skill | Use when |
|---|---|
| `skill-authoring` | Creating or improving a reusable skill together with its evals |

## Install

```sh
copilot plugin marketplace add OWNER/REPO
copilot plugin install customization-authoring@MARKETPLACE
```

Replace `OWNER/REPO` with the GitHub repository that hosts this marketplace
and `MARKETPLACE` with the `name` in its `marketplace.json`. See
[Install plugins](../../README.md#install-plugins) for VS Code.

## What this teaches

- **Discovery:** the description names the authoring task and excludes ordinary
  coding and factual questions.
- **Progressive disclosure:** the skill reads its [eval reference](skills/skill-authoring/references/evals.md)
  only when it writes the eval.
- **Workspace boundaries:** generated files go under the active workspace root,
  never inside the installed skill directory.
- **Honest results:** the skill distinguishes static inspection from an eval
  that actually ran, and it doesn't run paid evals unless asked.

## Try it

> Create a skill and evals for summarizing a changelog.

The skill asks only for details that change the result, then writes the skill and
an `eval.yaml` that loads it, checks an outcome, and includes an unrelated prompt
that must not trigger it.

## Customize

Point the eval reference at your team's conventions, such as required tags or a
suite name. The shipped reference already follows this marketplace's coverage
rules: asset tags, a smoke case, and an observable negative control. Keep this skill's own evaluation data out of the skill directory.

## Host checks

Before a release, try these by hand in each host you support. Automated tests
and evals don't prove that a host loads or shows everything.

- Ask Copilot to create a skill and evals for summarizing a changelog. Confirm
  the `skill-authoring` skill runs and writes `SKILL.md` and `eval.yaml` in
  your workspace, not inside the installed plugin.
- Lint the generated files with `vally lint --strict` and confirm they pass.
- Ask an ordinary coding question and confirm the skill doesn't run.
