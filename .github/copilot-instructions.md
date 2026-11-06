# Copilot instructions

This repository is a marketplace of Copilot plugins. Before changing anything,
read [AGENTS.md](../AGENTS.md) for the maintenance rules and
[CONTRIBUTING.md](../CONTRIBUTING.md) for the change checklist.

- Keep each plugin self-contained, and change its manifest, catalog entry,
  changelog, `.vally.yaml` entries, and evals together. Use
  `npm run new-plugin`, `npm run remove-plugin` (or `remove-example`), and
  `npm run rename-marketplace` instead of editing registrations by hand.
- Run `npm run build` after changing generated-file sources, then `npm run verify`.
- Don't run `npm run eval`, `npm run eval:smoke`, or the evals workflow unless
  asked; they spend AI credits.
  `npm run eval:list` and `npm run check-remotes` don't call a model.

This file applies to work in this repository only. Installing a plugin from the
marketplace doesn't copy it into other projects.
