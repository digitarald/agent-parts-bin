# Security

## Report a vulnerability

Don't report security problems in public issues, discussions, or pull requests.


Use GitHub's [private vulnerability reporting](https://github.com/digitarald/agent-parts-bin/security/advisories/new)
to contact this marketplace's maintainer, `@digitarald`.
This is a personal experiment bin, not a GitHub-supported product.

Experiments are not evaluated for safety or reliability. Use a disposable
environment without secrets or important files. A clean static check is not a
security review.

Include the affected plugin and version, the host and version you used, steps
to reproduce, and the impact you observed. Leave out real secrets and private
data.

## What plugins can do

Installing a plugin registers it; it runs nothing yet. Once Copilot loads an
installed, enabled plugin, its code can run on the installer's machine with
their permissions, without asking each time:

- **Hooks** run commands automatically on events such as every successful edit,
  and can change files, for example by reformatting them. A hook isn't a
  security boundary and never replaces CI.
- **MCP servers** run as local processes and can do anything their code does.
- **Canvas and SDK extensions** run code in the Copilot host and may start local
  servers. A local server should listen only on `127.0.0.1` and check the
  `Host` and `Origin` of every request.
- **Skills, agents, rules, and commands** shape what the model does, including
  which tools it calls.
- **Remote plugins** come from another repository. This marketplace never enables
  them automatically, and its checks never download or run them. Each one is
  pinned to a commit, which names what was reviewed but doesn't make it safe.
  Review them yourself before installing.

Opening a trusted checkout of this repository enables every local plugin in it,
the same as installing them all.

Review a plugin before you trust it, and install only what you need.
[Security and data handling](docs/security.md) describes what runs when, where
data goes, and a review checklist for new plugins.

## Maintaining this marketplace

- Review changes to `.github/workflows/`, `scripts/`, `evals/`, `plugins/`,
  `marketplace.json`, and `.github/copilot/settings.json` carefully. Same-repository
  pull requests can run changed code in the eval workflow with its token.
- Require review from code owners through branch protection or a ruleset.
- Pin actions to full commit SHAs and remote plugins to full commit SHAs.
  `npm run verify` rejects a remote plugin without one.
- Add required reviewers to the `evals` environment before you turn on pull
  request evals. See [Continuous integration](docs/ci.md#security).
- Keep secrets out of files, fixtures, eval specs, and transcripts.
