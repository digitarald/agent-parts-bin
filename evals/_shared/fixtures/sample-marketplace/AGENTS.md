# Maintaining this marketplace

This is a synthetic GitHub Copilot plugin marketplace for evals.

- Each local plugin lives in `plugins/<name>/` with `plugin.json`, `README.md`,
  and `CHANGELOG.md`, and it's listed in `marketplace.json`.
- Changes since a known released base need a semver bump in `plugin.json` and
  `marketplace.json`, and a matching changelog heading. An explicitly unreleased
  first version keeps its current version and heading. Never lower versions,
  bump twice, or rewrite history. Ask if the released base or first-release
  status is unknown; a PR base isn't a release record.
- `.github/copilot/settings.json` turns on only this marketplace's own
  maintenance plugin, sample-notes. Never add other plugins to it.
- Remote plugins pin a full commit `sha`.
- A plugin's evals live in `evals/<name>/`.
- Use the `plugin-authoring` and `marketplace-maintainer` skills and the
  read-only `plugin-reviewer` agent when they fit the task.
