import { el, button, fmt, icon, disclosure } from "./ui.mjs";
import { ROLE_LABELS } from "./primitives.mjs";

function active(filter, candidate) {
  return filter?.kind === candidate.kind && filter.name === candidate.name && filter.role === candidate.role && filter.tool === candidate.tool;
}
function selection(label, filter, selected, choose, className) {
  const node = button(label, () => choose(filter), className);
  if (label) node.title = label;
  node.setAttribute("aria-pressed", String(active(selected, filter))); return node;
}

export function renderPrimitives(parent, rankings, { selected, choose, sessionCounts, compact = false } = {}) {
  const container = el("div", undefined, `primitives${compact ? " primitives-compact" : ""}`);
  const sections = [
    ["models", "Models", "requests"],
    ["skills", "Skills", "invocations"],
    ["mcps", "MCP servers", "tool calls"],
  ];
  const act = choose ?? (() => {});
  function labelRow(target, kind, item) {
    const filter = { kind, name: item.name, ...(item.displayName && item.displayName !== item.name ? { label: item.displayName } : {}) };
    const row = el("div", undefined, "primitive-entry");
    const line = el("div", undefined, "primitive-row");
    const name = selection(item.displayName || item.name, filter, selected, act, "primitive-name");
    name.title = item.name;
    line.append(name, el("strong", fmt(item.count)));
    if (sessionCounts) {
      const count = sessionCounts(filter);
      const link = selection("", filter, selected, act, "primitive-sessions");
      const label = `${count} session${count === 1 ? "" : "s"}`;
      link.setAttribute("aria-label", label); link.title = `Show ${label}`;
      link.append(icon("sessions"), el("span", fmt(count)));
      line.append(link);
    }
    row.append(line);
    if (kind === "models" && item.roles) {
      const roles = el("div", undefined, "model-roles");
      for (const [role, label] of Object.entries(ROLE_LABELS)) {
        if (!item.roles[role]) continue;
        const node = selection("", { ...filter, role }, selected, act, "role-count");
        node.setAttribute("aria-label", `${label} ${fmt(item.roles[role])}`);
        node.append(icon(role), el("span", fmt(item.roles[role])));
        node.title = `${item.roles[role]} ${role === "subagent" ? "subagent" : role === "main" ? "main-agent" : "unattributed"} model requests`;
        roles.append(node);
      }
      row.append(roles);
    }
    if (kind === "mcps" && item.tools?.length) {
      const detail = el("details", undefined, "mcp-tools");
      detail.open = selected?.kind === "mcps" && selected.name === item.name && Boolean(selected.tool);
      detail.append(disclosure(fmt(item.tools.length), "tools", `${item.tools.length} tool${item.tools.length === 1 ? "" : "s"}`));
      const list = el("div", undefined, "tool-list");
      for (const tool of [...item.tools].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))) {
        const toolRow = el("div", undefined, "primitive-row");
        toolRow.append(selection(tool.name, { ...filter, tool: tool.name }, selected, act, "primitive-name"), el("span", fmt(tool.count)));
        list.append(toolRow);
      }
      detail.append(list);
      row.append(detail);
    }
    target.append(row);
  }
  for (const [kind, title, unit] of sections) {
    const section = el("section", undefined, `primitive-section primitive-${kind}`);
    const head = el("div", undefined, "primitive-heading"); head.append(el("h3", title), el("span", unit));
    section.append(head);
    const entries = [...(rankings[kind] ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    for (const item of entries.slice(0, compact ? 3 : 5)) labelRow(section, kind, item);
    if (!entries.length) section.append(el("p", kind === "skills" ? "No recorded skill invocations." : kind === "mcps" ? "No calls with recorded MCP attribution." : "No recorded model requests.", "primitive-empty"));
    if (entries.length > (compact ? 3 : 5)) {
      const more = el("details", undefined, "primitive-more");
      more.append(disclosure(`+${entries.length - (compact ? 3 : 5)} more`, undefined, `Show all ${entries.length} ${title.toLowerCase()}`));
      for (const item of entries.slice(compact ? 3 : 5)) labelRow(more, kind, item);
      section.append(more);
    }
    container.append(section);
  }
  if (rankings.tools?.length) {
    const other = el("details", undefined, "other-tools");
    const count = rankings.tools.reduce((sum, item) => sum + item.count, 0);
    const summary = disclosure("Other tools", "tools", `Other tools · ${fmt(count)} call${count === 1 ? "" : "s"}`);
    summary.append(el("span", fmt(count), "disclosure-count"));
    summary.title = `${count} calls, including tools without recorded MCP attribution`;
    other.append(summary);
    const list = el("div", undefined, "tool-list");
    for (const item of [...rankings.tools].sort((a, b) => b.count - a.count).slice(0, 20)) labelRow(list, "tools", item);
    other.append(list);
    container.append(other);
  }
  parent.append(container);
  return container;
}
