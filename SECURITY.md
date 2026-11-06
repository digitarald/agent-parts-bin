# Security

## Report a vulnerability

Don't report security problems in public issues, discussions, or pull requests.

<!-- template-only -->
Thanks for helping make GitHub safe for everyone.

GitHub takes the security of our software products and services seriously, including all of the open source code repositories managed through our GitHub organizations, such as [GitHub](https://github.com/GitHub).

Even though [open source repositories are outside of the scope of our bug bounty program](https://bounty.github.com/index.html#scope) and therefore not eligible for bounty rewards, we will ensure that your finding gets passed along to the appropriate maintainers for remediation.

If you believe you have found a security vulnerability in any GitHub-owned repository, please report it to us through coordinated disclosure.

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, please send an email to opensource-security[@]github.com.

Please include as much of the information listed below as you can to help us better understand and resolve the issue:

  * The type of issue (e.g., buffer overflow, SQL injection, or cross-site scripting)
  * Full paths of source file(s) related to the manifestation of the issue
  * The location of the affected source code (tag/branch/commit or direct URL)
  * Any special configuration required to reproduce the issue
  * Step-by-step instructions to reproduce the issue
  * Proof-of-concept or exploit code (if possible)
  * Impact of the issue, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

See [GitHub's Safe Harbor Policy](https://docs.github.com/en/site-policy/security-policies/github-bug-bounty-program-legal-safe-harbor#1-safe-harbor-terms)
<!-- /template-only -->

<!-- Replace this section with your team's reporting channel before you ship. -->
Use this repository's **Security** tab to
[report a vulnerability privately](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository),
if private vulnerability reporting is turned on. Otherwise contact this
marketplace's maintainers privately. After you set up
[.github/CODEOWNERS](.github/CODEOWNERS), list them there so reporters know who
to contact.

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
