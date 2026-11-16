# Session Lens

An experimental, read-only canvas for local Copilot activity. Browsing makes
no model calls, uses no external services, and uploads nothing.

Registration is silent and reads no session sources until a canvas opens.
Read and server failures still emit session diagnostic codes.

Ask **"Show my Copilot activity today."**

## Explore your activity

- **Activity** opens on Today. Choose dates, focus a day or hour, and see
  recorded tokens, model roles, skill invocations, and MCP calls.
- **Models, Skills, and MCP servers** link to the sessions that used them.
  MCP servers expand into tools; other tools stay secondary. These filters
  narrow the session list without changing the range totals.
- **Session details** open at a matching recorded step while keeping the full
  history available. The breadcrumb restores your range, filters, and list
  position.
- **Context and work** show estimated content sizes, request history, file and
  command activity, and delegated agents. Select an entry for source evidence.
  Revealing message or tool content requires explicit local opt-in.

Dates use the displayed local time zone. Charts adapt from hours to days,
weeks, months, and years. View options include themes, auto-refresh, and a
default-on **Limit history to 30 days** toggle.

See [PRODUCT.md](PRODUCT.md) for product goals and design context.

## Install

From this checkout:

```sh
copilot plugin install ./plugins/session-lens
```

From the marketplace:

```sh
copilot plugin marketplace add digitarald/agent-parts-bin
copilot plugin install session-lens@agent-parts-bin
```

Reinstall cached plugins after source edits, then reload extensions. The host
must provide `@github/copilot-sdk/extension` and canvas support. See the
[host matrix](../../docs/customization-types.md#where-each-type-works);
CLI installation alone does not prove an existing VS Code session loaded it.

The canvas ID is `parts-bin-session-lens`. Open with `{}` for Activity or
`sessionId` for a specific session. An optional `sessionRoot` selects an absolute
path to a compatible log directory. Reuse the instance handle to keep the
selected view and session.

Actions are `list_sessions`, `select_session`, and `get_snapshot`.
`get_snapshot` requires a selected session. Actions return IDs and aggregate
measurements, never transcript bodies.

## Read the numbers

- Recorded input, output, and cache counts come from usage receipts. Cache
  tokens are already included in input. Checkpoints, shutdown totals, and child
  summaries are not added again.
- `~` marks text-size estimates, not exact model tokenization or context-window
  occupancy. Missing system prompts, schema bodies, media, and referenced skill
  content are not invented or carried forward.
- Model roles follow recorded ownership and delegation. Unidentified named
  agents stay unattributed.
- Skills count explicit invocations, not catalogs or tool starts. MCP grouping
  requires recorded server/tool metadata; **Other tools** may include MCP calls
  whose attribution is missing.

Counts show usage, not skill quality, context effectiveness, or guaranteed
prompt inclusion. Separate logs can contain inherited usage, so totals are
observed session traffic, not deduplicated account billing or an invoice.

## Sources and limits

The adapter reads `<sessionRoot>/<id>/events.jsonl`. The default root is
`session-state` under a nonempty `COPILOT_HOME`, otherwise `~/.copilot`.
It does not search VS Code storage, databases, or remote machines.

The 30-day limit skips files last modified before the local-calendar cutoff
and excludes older events in eligible files. Older sessions active recently
still qualify. Copied logs with preserved timestamps may be omitted; disable
the limit for a full archive scan. The limit does not restrict an explicitly
opened session's history.

| Bound | Limit |
|---|---|
| Recent-session picker | 100 files |
| Activity batch | Up to 20 files or 32 MiB of uncached input; one file may exceed the byte target |
| Per-file scan | 64 MiB, 200,000 lines, 4 MiB per line |
| Retained details | 2,000 rows; correlation for up to 10,000 tool calls |
| Local content preview | 24,000 characters |
| Aggregate cache | Up to 1,000 summaries, in memory only |

Scans show progress and provisional totals. Pause/resume takes effect between
batches; entering a session pauses the scan. Refresh keeps the previous
snapshot visible until its replacement is ready. Cache entries are invalidated
by file identity, size, modification time, and time zone.

Rotated segments are not merged. Malformed, oversized, capped, or undated
records produce coverage warnings. File/command extraction recognizes a limited
set of tool shapes and may miss shell-generated work. The content browser is
an observed event history, not a verified assembled model prompt.

## Security and data handling

Raw logs can contain credentials, private code, personal data, and prompt
injections. Previews render plain text and require explicit reveal. Anyone
viewing the panel can see revealed content.

| Question | Answer |
|---|---|
| What runs, and when | SDK extension registers on load; a per-panel HTTP server starts on open. |
| Files read or written | Reads regular log files within the selected root; rejects traversal and symlink escapes. No direct log or preference writes; errors emit session diagnostics. |
| Network destinations | `127.0.0.1` on an ephemeral port. No outbound requests. |
| Credentials or tokens | No host credentials. Per-panel HttpOnly, SameSite cookies, Host/Origin checks, and CSP gate local access. |
| Data retained | Bounded in-memory snapshots until eviction or provider shutdown. |
| Data sent to the model | IDs and aggregates requested through canvas actions. No workspace labels or local preview content. |
| Dependencies | Node built-ins and the host-provided SDK; no bundled libraries or install scripts. |
| Remote sources | None. |
| Ownership and approval | Personal marketplace experiment; review source before enabling. |

The extension runs with your OS permissions. Loopback checks do not contain
other processes running as your user; this is not a sandbox.

## Development

```sh
node --test test/session-lens.test.mjs
SESSION_LENS_BROWSER=1 node --test test/session-lens-browser.test.mjs
npm run verify
```

Tests use synthetic logs and make no model calls. The optional browser check
uses the repository's Playwright runtime; `SESSION_LENS_BROWSER_EXECUTABLE` can
select an installed Chromium-family executable. No behavioral evals are shipped
or required.

## Host checks

- Reload the installed extension without opening a canvas. Confirm no startup
  readiness message or `session.info` event is added.
- Reload the installed extension and open `{}`. Check date ranges, the history
  limit, progressive scanning, and refresh without blanking results.
- Filter by a skill, MCP tool, or model role; enter a session and return.
  Confirm the interval, filters, and list position survive.
- Check context hover/pin, expanded tools, keyboard labels, and narrow layouts.
  Uncheck content reveal during a pending read; the response must stay hidden.
- Open with `sessionId`, call `get_snapshot`, and reopen the same instance.
  In a host without canvases, the skill must report the limitation.

Headless tests do not establish native rendering or compatibility across hosts.
