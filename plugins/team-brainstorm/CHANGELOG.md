# Changelog

## 1.1.2

- Remove the plugin's own `LICENSE`. The plugin is still MIT licensed, under
  the repository's root `LICENSE`.

## 1.1.1

- Add a Host checks section to the README for the manual release checks.

## 1.1.0

- Serve each panel under a random path, so other local processes can't reach the board by port alone.
- Say plainly that the board isn't protected from software running as you, and keep sensitive data off it.

## 1.0.3

- Replace the starter-specific install values in the README with generic ones.

## 1.0.2

- Decode board requests once from their raw bytes, so a character split across
  network chunks isn't corrupted, and apply the 4 KiB limit to bytes.
- Add an Install section and the plugin's own MIT `LICENSE`.

## 1.0.1

- Keep keyboard focus on note controls when incoming board updates replace notes.
- Return focus to the note input if another participant deletes the focused note.

## 1.0.0

- Initial session-only brainstorm canvas and companion skill.
