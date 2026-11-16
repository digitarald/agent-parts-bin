## What and why

<!-- Describe the experiment. Link an issue if there is one. -->

## Checklist

<!-- Check each item, or mark it N/A with a short reason, for example "N/A: no generated sources changed". -->

- [ ] For changes since a known released base, bumped `version` in `plugin.json` and `marketplace.json` and added a `CHANGELOG.md` entry. Kept unreleased first versions and avoided duplicate bumps.
- [ ] Kept the catalog description identical to the manifest. The repository overlay enables local plugins for development, never remote entries.
- [ ] Updated `.vally.yaml` `paths.skills` and `params` for added, renamed, or removed plugins.
- [ ] Documented what was checked, known failures, and any untested behavior. Evals are optional.
- [ ] Updated the plugin's README and any other docs that describe what changed.
- [ ] Ran `npm run build` if sources of generated files changed, and committed the `dist/` output.
- [ ] `npm run verify` passes.
- [ ] Used only synthetic data; no secrets, tokens, or private code.

## Risk

<!-- For a new plugin, or one that changes what it can run, read, write, or reach, fill in this table. Write "none" where it doesn't apply. See docs/security.md. -->

| Question | Answer |
|---|---|
| What runs, and when: hooks and their events, MCP servers, extensions, scripts | |
| Files it reads or writes, and how it limits them | |
| Network destinations | |
| Credentials or tokens it uses, and where they come from | |
| Data it keeps, where, and for how long | |
| Data it sends to the model | |
| New dependencies, their licenses, and install scripts | |
| Remote sources: repository, path, and pinned sha | |

## Paid evals

<!-- List the evals you ran, for example `node .github/scripts/evals.mjs eval --plugin <name>`, and their results, or say "None". -->
