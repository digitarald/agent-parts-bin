# Decide

Typed decisions for bounded classification, routing, and scoring through a user-configured Microsoft Foundry deployment.

An experimental skill and a Python CLI for asking a decision model bounded
questions. It returns booleans, choices with probabilities, or scores as JSON.
Python 3.10 or newer is required; no Python packages are needed.

No behavioral evals or accuracy claims. Probabilities are model outputs,
not measured accuracy. Keep deterministic checks and permission decisions in
the caller.

## Install

```sh
copilot plugin marketplace add digitarald/agent-parts-bin
copilot plugin install decide@agent-parts-bin
```

Start a new session. Example request:

> Use Decide to design a routing policy for these synthetic support tickets.
> Show the request with a dry run, without calling a model.

In VS Code, install from `digitarald/agent-parts-bin`. See the
[marketplace instructions](../../README.md#install-plugins).

## Setup and data handling

The package includes no Azure resource endpoint, credentials, or personal
configuration. Each user supplies a Microsoft Foundry resource endpoint and
deployment. Read [setup and authentication](skills/decide/references/setup.md).
Agents must use `--non-interactive` and must not collect secrets in chat.

Live decisions send the supplied state and questions to that configured
resource and may incur charges. Only send data approved for that destination.
There are no automatic retries.

Endpoint and deployment settings stay in the user's configuration directory,
outside the plugin. On macOS, setup stores API keys in Keychain; other
platforms use environment credentials. Installation does not run setup, call
the model, or change credentials. No hooks or MCP servers run automatically.

For offline inspection, run these from this plugin's directory:

```sh
python3 skills/decide/scripts/decide.py schema
python3 skills/decide/scripts/decide.py batch --non-interactive \
  --input skills/decide/assets/triage.json --dry-run
python3 -B -m unittest discover -s skills/decide/tests -v
```

The fixtures use synthetic input and example resource names. The response
fixtures show the output contract, not an accuracy benchmark.

## Host checks

- Copilot CLI: confirm the installed `decide` skill is discovered, then run
  `schema` and a synthetic `--dry-run` using the installed skill's path.
- VS Code: start a new chat, confirm the skill appears in
  **Chat: Configure Skills**, and ask for an offline dry run.
- Live model access, routing quality, and native host invocation have not been
  verified for this plugin release. Only offline CLI and packaging checks are
  automated.
