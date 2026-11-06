# Remote plugins

The catalog can list plugins that live in another repository. They're opt-in:
the repository overlay never enables a remote plugin, and `npm run verify`
rejects an overlay that does, because checking out this repository must not
activate code fetched from somewhere else. Each developer installs remote
plugins themselves.

Local checks validate a remote entry's metadata only. They never download or
run upstream code, and the local evals don't cover remote plugins: `evals/` is
for the plugins under `plugins/`, and the coverage check rejects asset IDs that
aren't local. Evaluate an upstream plugin in its own repository.


## Add a remote plugin

A remote entry looks like this:

```json
{
  "name": "anarlog",
  "source": {
    "source": "github",
    "repo": "fastrepl/anarlog",
    "path": "agent-plugins/anarlog",
    "ref": "main",
    "sha": "259b68866a7d6c331cd428aaa33a33300a700c5d"
  },
  "version": "1.3.0",
  "description": "Search local Anarlog meetings or connect to Cloud with OAuth.",
  "homepage": "https://docs.anarlog.so/agents/overview"
}
```

The rules, which `npm run verify` checks:

| Field | Rule |
|---|---|
| `name` | Required. Must equal the `name` in the upstream plugin's `plugin.json`, not the repository or upstream marketplace name. |
| `source.source` | Required. Only `github` is supported. |
| `source.repo` | Required. `OWNER/REPO`, not a URL. |
| `source.path` | The directory that holds `plugin.json`, relative to the repository root, such as `packages/plugin`. No leading `./` or `/`, no `..`, and no backslashes. Omit it when `plugin.json` is at the root. |
| `source.sha` | Required. The full 40-character commit SHA you reviewed. A tag or branch can move; a commit can't. |
| `source.ref` | Recommended. The release tag or branch the SHA came from, so reviewers can tell what's pinned. `verify` warns without it. |
| `version` | Optional. The upstream `plugin.json` version at that SHA. |
| `description`, `homepage` | Optional, but they help people choose. |

No other `source` fields are allowed, and credentials never go in the catalog.
Installers authenticate with their own GitHub account; document any
private-repository access requirement.

To get the SHA for a tag or branch, and to read the upstream manifest at that
SHA:

```sh
gh api repos/OWNER/REPO/commits/REF --jq .sha
gh api "repos/OWNER/REPO/contents/PATH/plugin.json?ref=SHA" -H "Accept: application/vnd.github.raw"
```

`commits/REF` returns the commit a tag points at, even for an annotated tag,
whose own object ID differs. Some projects tag a release and then build it in
a later commit; pin the commit their own catalog uses.

## Check pins against GitHub

```sh
npm run check-remotes
npm run check-remotes -- anarlog
```

This uses the network, so `npm run verify` doesn't run it. For each remote
entry it confirms that the repository and SHA exist, that `plugin.json` is at
`path` at that SHA, and that its `name` and `version` match the catalog. It
reads the manifest the way Copilot CLI does: an Agent Plugins `plugin.json` at
`path` first, then the legacy locations (`.plugin/plugin.json`, `plugin.json`,
`.github/plugin/plugin.json`, and `.claude-plugin/plugin.json`), and it notes a
legacy manifest, since other hosts may not load one. It also notes when `ref`
has moved away from the pin and when the repository has a newer release. It
authenticates with `GH_TOKEN` or `GITHUB_TOKEN`, or your GitHub CLI login.

## Keep pins current

Nothing updates remote pins for you. Dependabot doesn't read `marketplace.json`.
Pick a cadence, such as once a month or when upstream announces a release:

1. Run `npm run check-remotes` and read its notes.
2. Review what changed upstream between the pinned SHA and the new one.
3. Update `sha`, `ref`, and `version` together, and run `npm run verify` and
   `npm run check-remotes`.
4. Say in the pull request what you reviewed.

To get a reminder, you can run the check on a schedule. This workflow is an
example, not part of the template; it only reads public data with the job's
token, and a private upstream needs a token that can read it:

```yaml
name: Check remote plugins
on:
  schedule:
    - cron: "0 9 * * 1"
  workflow_dispatch:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npm ci
      - run: npm run check-remotes
        env:
          GH_TOKEN: ${{ github.token }}
```

Pin each action to a full commit SHA before you use it, as the shipped
workflows do.

After a pin changes, teammates pick it up with
`copilot plugin marketplace update`, then
`copilot plugin update <plugin>@<marketplace>`. Whether Copilot also refreshes
a marketplace on its own, and when, isn't verified here.

## Test a remote entry

You can't fully test a remote entry from your local checkout. When a
marketplace is added from a local directory, Copilot CLI treats every plugin in
it as a live local folder. Installing a remote plugin from it downloads the
plugin, and the next CLI command removes that download again, because there's
no matching folder in the checkout. This was observed with an isolated
`COPILOT_HOME` and the pinned Copilot CLI 1.0.98: `plugin install` succeeded,
and the next `plugin list` didn't show the plugin and its files were gone.

To test your pins:

- Run `npm run check-remotes`. It checks the repository, SHA, path, name, and
  version without installing anything.
- To test an install, push the change to a repository you control, such as a
  private test copy, and add that repository as the marketplace with
  `copilot plugin marketplace add OWNER/REPO`. The install then uses your pin.
  This template hasn't tested that path end to end.
- Installing from upstream's own marketplace, or with
  `copilot plugin install OWNER/REPO`, tests upstream's current version, not
  your pin. The CLI also warns that direct repository installs are deprecated.

## Policy

Pinning names the code you reviewed; it doesn't make it safe. Review a remote
plugin as you'd review any dependency, using the checklist in
[Security and data handling](security.md#review-a-plugin). Removing an entry
here doesn't stop people from installing the same plugin from another
marketplace.
