---
name: session-todos
description: Open a compact live monitor of the current session's todos, progress, blockers, and recent edits. Use when the user wants to watch the agent's plan while working, not to edit tasks or browse other sessions.
---

Open the `parts-bin-session-todos` canvas without input. Reuse the same instance
when reopening it. It reads the joined session's plan API and follows
`session.todos_changed`; no agent loop, SQL tool call, or polling prompt is needed.

The canvas is read-only. `refresh` rereads the runtime; `get_state` returns the
current view, including an error if its last read failed. Do not copy todos into
canvas state or use it as a second task store. If the host cannot display
canvases or lacks the plan API, explain that limitation.
