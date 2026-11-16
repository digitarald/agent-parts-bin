# Copilot instructions

Agent Parts Bin is `@digitarald`'s rough experiment marketplace. No behavioral
evals or reliability promises are required. Document risks and known failures;
dependable plugins belong in `digitarald/agent-toolbelt`.

This repository is a marketplace of Copilot plugins. Before changing anything,
read [AGENTS.md](../AGENTS.md) for the maintenance rules and
[CONTRIBUTING.md](../CONTRIBUTING.md) for the change checklist.

- Keep each plugin self-contained, and change its manifest, catalog entry,
  changelog, `.vally.yaml` entries, and any existing evals together. Evals are
  optional and are not part of the `verify` publishing gate. Use the retained
  maintenance commands. Keep template updates limited to infrastructure;
  don't restore removed template plugins or their evals. The repository overlay
  enables local plugins, never remote entries.
- Run `npm run build` after changing generated-file sources, then `npm run verify`.
- Don't run `npm run eval`, `npm run eval:smoke`, `npm run eval:models`, or the evals workflow unless
  asked; they spend AI credits.
  `npm run eval:list` and `npm run check-remotes` don't call a model.

This file applies to work in this repository only. Installing a plugin from the
marketplace doesn't copy it into other projects.
