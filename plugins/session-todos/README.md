# Session Todos

A read-only side panel for the current Copilot session's plan. Active work leads,
blockers stay visible, and completed work folds away. Recent edits briefly
highlight; completion stays visible for 15 seconds before joining the completed
list. Relative times describe changes observed while this panel is running, not
the original creation or start time of a task.

Ask to open Session Todos, or open canvas `parts-bin-session-todos` without input.
Actions: `refresh` and `get_state`. No task-editing controls or model calls.

```sh
copilot plugin install session-todos@agent-parts-bin
```

## Source and lifetime

Uses `session.rpc.plan.readSqlTodosWithDependencies()` and
`session.todos_changed` on the SDK session joined by the extension. No direct
database access, host-specific paths, external services, or credentials.
Snapshots use the SDK's `todoId`, `dependsOn`, and `createdAt` fields, not the
SQL tables' column names.
The runtime remains the source of truth. The SDK's plan reader can return an
empty list when its database or schema is unavailable; that is not distinguishable
from a session with no todos. Unknown statuses remain visible.

Observed change timestamps and expanded rows are transient. Reopening the same
live instance keeps change ages; a provider restart rereads the plan and resets
observation history. Nothing is written to a separate todo store. Transport or
schema failures retain the last successful snapshot with a visible error.

The HTTP page binds only to loopback. Todo text is visible to local users and
explicit `get_state` callers. The plugin is experimental; host canvas and plan
API support are required.

## Development

Canvas sources live in `canvases/session-todos/` at the repository root. The
small SDK adapter is in `src/`. Canvas-kit is an npm development dependency,
not copied source; React and the kit are compiled into the generated extension
and browser assets, with license notices. The host supplies its SDK at runtime.
Installed plugins do not need this checkout's `node_modules`. The repository's
esbuild pipeline compiles the kit and UI; Vite is deliberately not installed
because its required Lightning CSS dependency is MPL-licensed.
The repository's `.npmrc` disables automatic peer installation for this
esbuild-only setup; it does not install canvas-kit's unused Vite adapter.

Use Node.js 24+ for canvas-kit authoring:

```sh
npm ci
npm run build
npm run test:canvas
npm run test:canvas:browser
```

The checked-in entry point is
`com.github.copilot/extensions/session-todos/extension.mjs`.
Build before installing from this local marketplace; reload extensions afterward.
Browser tests supply synthetic snapshots through the same adapter.

## Host checks

In each canvas-capable host, open the canvas, change a session todo, and check
that the edit appears without a model call. Reopen the same instance and confirm
its observed change age remains. Check sidebar/wide layouts and keyboard details.
A fresh Copilot chat verified discovery, open, both actions, automatic todo
addition/removal updates, and same-instance reopen with unchanged change ages.
The existing chat did not discover the new plugin after reload; start a new
chat after installation. Browser tests cover interactions and three themes;
native rendering in other hosts remains unverified.
