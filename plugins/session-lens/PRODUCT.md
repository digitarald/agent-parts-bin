# Session Lens

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People using Copilot who want to understand their activity, token usage, and
which models, skills, and MCP connections their sessions used.

The common job is reviewing a day or week. Inspecting an individual session
is a secondary task for explaining something found in that overview.

## Product purpose

Make local agent activity understandable without asking an agent to analyze
every log. Help users move from "What happened today?" to the sessions and
recorded events behind it.

Skills and MCPs deserve attention because they represent workflows and context
sources. Generic tool counts are supporting detail, not the product's focus.

## Operating context

Session Lens is an experimental plugin canvas inside a Copilot host. Users
move between an activity overview and session details while working in their
editor. They may use narrow panels, large windows, or light and dark themes.

Activity starts on Today and supports local-calendar date ranges. A default
30-day history limit keeps the initial scan bounded; users can include older
history. Returning from a session should restore the range and the user's
place in the list.

## Capabilities and constraints

- Review activity and token usage across dates, with charts that adapt to the
  selected interval.
- Find sessions by model role, skill invocation, MCP server, or MCP tool.
  Distinguish main-agent and subagent usage where recorded.
- Inspect a session's content history, file and command activity, delegation,
  and source evidence.
- Browse locally without model calls or uploads. Do not modify logs or execute
  recorded commands.
- Keep recorded usage separate from content-size estimates. Logs do not prove
  exact prompt membership, skill quality, context effectiveness, or billing.
- Treat session content as private. Revealing it requires explicit user action.
- Be clear about incomplete logs and host-dependent availability. Do not
  silently remove a requested capability because its data is hard to find.

## Brand commitments

Compact, editor-like, and practical. Preserve a coherent experience between
the overview and session details rather than inventing a new design for each.

Use lean wording and recognizable icons where they reduce repetition.
Keep important names and counts readable. Explanations should be available
without dominating the workspace.

## Product principles

- Start with a time range; use sessions as the path to deeper evidence.
- Keep Models, Skills, and MCPs visible; make ordinary tools secondary.
- Preserve context and position through filtering, drill-down, and refresh.
- Show what is known, distinguish estimates, and surface gaps honestly.
- Prefer useful deterministic inspection over automatic agentic interpretation.

## Accessibility

Support keyboard navigation, visible focus, accessible icon labels, readable
contrast, reduced motion, and narrow layouts. Density must not make controls
ambiguous or hide the meaning of a measurement.

## Evidence on hand

The working canvas uses local session records and synthetic test fixtures.
Usage and attribution can be checked against source events; effectiveness
claims cannot be inferred from those counts.

See the [README](README.md) for installation, measurement caveats, data limits,
privacy, and validation.
