---
name: json-configuration
description: Validate supplied JSON configuration and look up values by JSON Pointer using the local JSON configuration MCP tools. Use for checking whether JSON is valid or locating a specific configuration value. Don't use for YAML, arbitrary filesystem browsing, or unrelated coding and factual questions.
---

# Inspect JSON configuration

Use the bundled local MCP tools rather than guessing from the text.

1. Obtain the JSON text and, for lookup requests, the JSON Pointer. Don't read unrelated files or credential stores.
2. Call `validate_json` to check syntax. Report its `valid` result. If the JSON is invalid, report `INVALID_JSON`; don't silently repair the input.
3. For a lookup, call `get_json_value` with the unchanged JSON and pointer. Empty pointer selects the whole document; `~1` represents `/` and `~0` represents `~` within a key.
4. Report the actual returned value. Distinguish `found: true` with `value: null` from `NOT_FOUND`. Report `INVALID_POINTER` separately. Don't invent a default value.

The server accepts at most 1,048,576 characters of JSON text. Numbers use finite JavaScript number semantics, not arbitrary precision. Overflowing numbers are explicitly rejected rather than converted to null; use JSON strings for exact large integers or decimals. It has no network, filesystem, or credential access and doesn't persist the supplied JSON. Don't include sensitive JSON in saved reports unless the user explicitly requests it.

If the tools aren't available, state that the JSON configuration plugin isn't connected. Don't claim tool-backed validation without a real tool call. No edits or other side effects are needed.
