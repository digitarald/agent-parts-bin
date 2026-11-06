# Team brainstorm

A shared, session-only brainstorm board for a person and Copilot.

| Skill | Use when |
|---|---|
| `team-brainstorm` | Exploring ideas, comparing options, or collecting questions and next steps |

## Install

```sh
copilot plugin marketplace add OWNER/REPO
copilot plugin install team-brainstorm@MARKETPLACE
```

Replace `OWNER/REPO` with the GitHub repository that hosts this marketplace
and `MARKETPLACE` with the `name` in its `marketplace.json`. See
[Install plugins](../../README.md#install-plugins) for VS Code.

## How it works

The skill opens `marketplace-starter-brainstorm`. The human edits notes in the
page; the agent uses `get_board`, `save_note`, and `remove_note`. Server-sent
events keep human and agent changes visible without polling.

There are three columns: Ideas, Questions, Next. Edit a note to change its column.
Incoming updates preserve keyboard focus on the same note control, including
when a note moves columns. If that note is deleted, focus returns to the input.
Each session owns one in-memory board, shared by its panels. Reopening a panel
preserves notes. Ending or reloading the extension discards them. No export,
disk storage, external services, or credentials.

Node.js 22.12+ and a Copilot host with SDK canvas presentation are required.
The runtime resolves `@github/copilot-sdk/extension`; do not install it into the
plugin. Hosts without canvas presentation can still use the skill in chat.
The loopback server binds only to `127.0.0.1`, rejects foreign Host/Origin
headers, serves the board only under a random path for each panel, and closes
when the runtime closes its instance. These checks stop web pages and casual
local requests, not software that runs as your account, so don't put secrets or
sensitive data on the board. Copilot and its model also read every note.

## Structure

```text
plugin.json
skills/team-brainstorm/SKILL.md
com.github.copilot/extensions/brainstorm/
  extension.mjs     # SDK registration, actions, lifecycle
  board.mjs         # Session-local note model and validation
  server.mjs        # Loopback HTTP and event stream
  index.html        # Plain HTML, CSS, and browser JavaScript
```

## Customize

Change the skill's workflow to match your team's planning habits. Change column
names in the board model, page, and skill together. Choose a distinctive canvas
ID when copying the plugin so independently installed examples do not collide.
Keep server and action input validation in the shared model.

## Host checks

Before a release, try these by hand in each host you support. Automated tests
and evals don't prove that a host loads or shows everything.

- Open the canvas, and add, edit, move, and delete notes from the page and
  from chat.
- Reopen the same panel and confirm the notes remain; a new session starts
  empty.
- Keep keyboard focus on a note control while Copilot edits or moves that
  note, and confirm focus stays there, or returns to the input if the note is
  deleted.
- In a host without canvases, confirm the skill keeps the brainstorm in chat.
- If you rename the canvas, update both its ID in the extension and the
  skill's reference to it.
