# Changelog

## 0.3.0

- Removed the startup readiness log, which caused the host to persist a
  `session.info` event before any canvas opened.
- Made date-range Activity the landing view, with adaptive hourly through yearly
  charts, DST-aware accounting, and a default-on 30-day history limit.
- Added progressive scanning, pause/resume, and refresh that preserves the
  previous snapshot. Session drill-down restores the selected interval and
  list position.
- Added visible model-role, skill-invocation, and MCP server/tool counts, with
  links to matching sessions and whole-session/selected-agent evidence.
- Limited content charts to recorded-text estimates; removed unsupported
  system/schema sizes, carry-forward counts, and window percentages.
- Standardized compact typography, icon/count controls, accessible disclosures,
  and bounded tool lists across Activity and session views.

## 0.2.0

- Added token-count provenance, historical prompt-snapshot correlation,
  agent-scoped history, and linked composition/content inspection.
- Fixed duplicate usage accounting, agent correlation, retained-tool counts,
  multi-panel cookies, and local-preview opt-out races.

## 0.1.0

- Introduced the deterministic, read-only session canvas and product spec,
  including usage history, local previews, work/agent views, and a bounded
  cross-session overview.
- Documented data gaps, privacy risks, host compatibility, and model-free tests.
