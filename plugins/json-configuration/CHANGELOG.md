# Changelog

## 0.1.7

- Rebuild the bundled server with fast-uri 3.1.9, which fixes four URI
  parsing advisories.

## 0.1.6

- Remove the plugin's own `LICENSE`. The plugin is still MIT licensed, under
  the repository's root `LICENSE`.

## 0.1.5

- Add a Host checks section to the README for the manual release checks.

## 0.1.4

- Describe the server's access accurately: the handlers don't use files, credentials, or the network, but the process runs with your permissions.

## 0.1.3

- Replace the starter-specific install values in the README with generic ones.

## 0.1.2

- Report the `plugin.json` version in the MCP handshake instead of a stale
  hardcoded `0.1.0`.
- Regenerate the bundled license notices with a per-bundle header.
- Add an Install section.

## 0.1.1

- Start the MCP server when it is launched through a symlinked path, such as
  macOS temporary folders.

## 0.1.0

- Initial skill and self-contained stdio MCP server with `validate_json` and
  `get_json_value` tools.
