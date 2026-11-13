# Changelog

## 1.0.3

- Include the plugin's native TypeScript hooks in the marketplace's normal type check.
- Report malformed hook JSON without echoing input in diagnostics.

## 1.0.2

- Move the plugin to the Agent Parts Bin marketplace and update installation guidance.
- Keep model-free tests in the marketplace's `test/` directory; installed runtime code remains self-contained.

## 1.0.1

- Fix installed plugin startup by removing an unnecessary import outside the package. All runtime code uses Node.js built-ins and ships inside the plugin.
- Add an isolated-package test covering startup, shell instrumentation, rejected commits, and stored attribution without the monorepo or `node_modules`.

## 1.0.0

- Initial release with a `commit` skill and automatic, persistent Git hook integration.
- Require Copilot attribution, add runtime session/model metadata, and preserve valid historical attribution.
- Chain existing hooks without changing tracked files; leave human commits unchanged.
