# Changelog

## 0.1.5

- Remove the plugin's own `LICENSE`. The plugin is still MIT licensed, under
  the repository's root `LICENSE`.

## 0.1.4

- Add a Host checks section to the README for the manual release checks.

## 0.1.3

- Teach this marketplace's coverage rules in `references/evals.md`: asset,
  control, and suite tags, skill-prefixed stimulus names, the marketplace skill
  path, and an observable negative control.
- List the graders that count as outcome checks, and say a custom grader
  program is optional.
- Replace the starter-specific install values in the README with generic ones.

## 0.1.2

- Fix the example eval's `file-matches` regex in `references/evals.md`. YAML
  single quotes keep backslashes, so it now uses single backslashes.
- Add an Install section.

## 0.1.1

- Resolve generated skill and eval paths against the caller's workspace, not the
  installed skill directory.

## 0.1.0

- Initial skill for authoring a focused skill with positive and negative Vally evals.
