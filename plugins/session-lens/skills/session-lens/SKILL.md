---
name: session-lens
description: Open Session Lens when the user wants to see Copilot activity or token usage today, yesterday, or over a date range, then drill into sessions, context, tools, files, and agents. Not for editing logs or diagnosing model quality.
---

# Session Lens

1. Inspect capabilities for `parts-bin-session-lens`, then open it with a stable
   instance handle and `{}` for the Activity landing view (Today). Its date
   controls use the browser's local time zone. History is limited to 30 days
   by default; the user can turn that limit off in View options. Use `sessionId` only when the
   user asks for a specific session; that opens its full history directly. An optional
   `sessionRoot` must be an explicitly chosen absolute path to a compatible
   runtime `session-state` directory, never a path guessed from VS Code storage.
2. The canvas reads local JSONL deterministically. Let the user explore its
   views; do not launch an agent or read raw transcript content to populate it.
3. Use `list_sessions`, `select_session`, or `get_snapshot` only when needed.
   Actions return IDs and aggregate measurements, not prompts, commands, paths,
   or tool results. Those aggregate action results enter the model conversation.
4. Distinguish recorded context from accumulated token traffic. Cache tokens
   are included in input. Checkpoints and child summaries must not be added to
   durable usage receipts. Missing data is not zero, and billing units are not
   currency.
   Activity counts, session rows, and rankings include only the chosen dates.
   Scanning is progressive; partial totals are labeled until all available
   files have been examined. Opening a row shows full session history, not a
   silently date-filtered session, focused on the selected interval when
   retained context permits. The breadcrumb restores the range and list position.
   Models, Skills, and MCP servers link to matching sessions and source events.
   MCP grouping requires recorded server metadata; unidentified tools are not
   assumed to be built-ins. Main/subagent model counts use recorded ownership.
   Invocation counts are not evidence that a skill or context was effective.
5. If the source is missing, ask for a compatible directory. If this host has
   no canvas support, explain the limitation and link the plugin documentation.
   Do not create another extension scope or claim native rendering succeeded.

The browser can reveal individual event payloads locally with explicit user
opt-in. Never send that content to an agent or external service automatically.
The installed plugin's README documents supported evidence and limitations.
