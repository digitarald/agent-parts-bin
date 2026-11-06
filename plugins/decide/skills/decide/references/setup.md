# Setup and authentication

The user runs setup in their own terminal, from the directory containing this
skill's `SKILL.md`:

```bash
python3 scripts/decide.py setup
```

The wizard asks for the Foundry resource URL, deployment name (default `Decision-1`), and a hidden API key. Values supplied through flags or environment variables skip the corresponding questions. Copy the URL and key from the deployment's Details page.

On macOS, the key is saved in Keychain and local storage is verified. Press Enter to keep a saved key. Run `setup` again to change the endpoint, deployment, or key.

Setup makes no billable API calls. Run a decision afterward to verify access to the model.

## First use and automation

In a human terminal, a decision with a missing endpoint or key starts setup, then continues the original request. CI, piped input, and `--non-interactive` disable automatic prompts. Missing setup exits 3 with `error.setup_required: true`. Rejected credentials and locked Keychain access do not trigger the wizard.

On macOS, `setup --endpoint URL --deployment NAME --key-stdin` supports headless provisioning from an explicitly piped secret source. There is no key argument. Never put a literal key in a command, shell history, chat, or this skill. Secrets reach Keychain through subprocess stdin, not process arguments.

On Linux/Windows, setup saves the endpoint/deployment and prints commands for hidden key entry into an environment variable:

```bash
# Bash. The key stays in this shell session.
read -rs -p "API key: " DECIDE_API_KEY
export DECIDE_API_KEY
printf '\n'
```

```powershell
# PowerShell. The key stays in this shell session.
$env:DECIDE_API_KEY = [System.Net.NetworkCredential]::new(
    "", (Read-Host "API key" -AsSecureString)
).Password
```

Run the CLI from that shell, or configure the agent's environment separately. An already-running agent does not inherit changes in another terminal. No plaintext secret file is created.

## Local configuration

Only the endpoint and deployment are stored in `~/.config/decide/config.json`, or `$XDG_CONFIG_HOME/decide/config.json`. Personal configuration stays outside the distributable skill.

Configuration precedence:

1. `--endpoint` and `--deployment`.
2. `DECIDE_ENDPOINT` and `DECIDE_DEPLOYMENT`.
3. Saved configuration; the deployment defaults to `Decision-1`.

Use `https://RESOURCE.services.ai.azure.com`, without project or API paths. The CLI appends `/providers/microsoft/v1/systemone`. OpenAI and project URLs are not accepted.

Credential precedence:

1. `DECIDE_API_KEY`.
2. `AZURE_API_KEY`.
3. `DECIDE_TOKEN`.
4. `AZURE_ENTRA_TOKEN`.
5. macOS Keychain, service `decide:<resource-name>`, account `api-key`.

Environment credentials override saved keys. Empty credentials are errors. A changed endpoint selects a different Keychain item. Tokens must target `https://cognitiveservices.azure.com`; the CLI does not log in or refresh them.

If Keychain is locked, the user must unlock it. Do not read or print keys to troubleshoot. Keychain reads time out after 5 seconds; HTTP calls default to 30 seconds (`--timeout` overrides this).

## Limits and maintenance

Local limits: 128 KiB per request, 32 questions, 2-255 choices, and 2-10 score levels. The model's 32K-token context limit also applies.

Focused checks:

```bash
python3 -B -m unittest discover -s tests -v
```

- [Microsoft's deployment and API guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-microsoft-decision)
- [Agent-native CLI design patterns](https://www.monperrus.net/martin/agent-native-cli-design)
