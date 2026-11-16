export const fmt = (value) => value == null ? "Not recorded" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: Math.abs(value) >= 10000 ? "compact" : "standard" }).format(value);
export const exact = (value) => value == null ? "Not recorded" : new Intl.NumberFormat().format(value);
export const date = (value) => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "No timestamp";
export const ms = (value) => value == null ? "Not recorded" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
export function el(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
export function button(label, fn, className) {
  const node = el("button", label, className); node.type = "button";
  node.addEventListener("click", fn); return node;
}
const iconPaths = {
  sessions: ["M5 2h9v9H5z", "M2 5v9h9"],
  tools: ["m3 12 5-5", "M9 2a4 4 0 0 0-4 5l-4 4a2 2 0 0 0 3 3l4-4a4 4 0 0 0 5-5l-3 3-2-2 3-3Z"],
  main: ["M8 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M2 15v-1a6 6 0 0 1 12 0v1"],
  subagent: ["M6 1h4v4H6zM1 11h4v4H1zM11 11h4v4h-4z", "M8 5v3M3 11V8h10v3"],
  unknown: ["M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Z", "M6 5a2 2 0 1 1 3 1.7C8 7.3 8 8 8 9M8 11v1"],
  chevron: ["m6 4 4 4-4 4"],
  info: ["M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Z", "M8 7v5M8 4v1"],
  refresh: ["M13 6a5 5 0 0 0-9-3L2 5M2 1v4h4", "M3 10a5 5 0 0 0 9 3l2-2M14 15v-4h-4"],
  settings: ["M2 4h12M2 12h12", "M5 2v4M11 10v4"],
  close: ["m4 4 8 8M12 4l-8 8"],
};
export function icon(name) {
  const svg = svgNode("svg", { viewBox: "0 0 16 16", class: `ui-icon${name === "chevron" ? " chevron" : ""}`, "aria-hidden": "true", focusable: "false" });
  for (const d of iconPaths[name]) svg.append(svgNode("path", { d }));
  return svg;
}
export function disclosure(label, glyph, accessibleLabel = label) {
  const summary = el("summary", undefined, "compact-disclosure");
  summary.setAttribute("aria-label", accessibleLabel); summary.title = accessibleLabel;
  summary.append(icon("chevron"));
  if (glyph) summary.append(icon(glyph));
  summary.append(el("span", label));
  return summary;
}
export function help(text) {
  const details = el("details", undefined, "inline-help");
  const summary = el("summary");
  summary.setAttribute("aria-label", "About these counts"); summary.title = "About these counts"; summary.append(icon("info"));
  details.append(summary, el("p", text)); return details;
}
export function iconButton(label, glyph, fn, className = "icon-button") {
  const node = button("", fn, className);
  node.setAttribute("aria-label", label); node.title = label; node.append(icon(glyph)); return node;
}
export function section(parent, title, note) {
  const node = el("section", undefined, "section"); node.append(el("h3", title));
  if (note) node.append(el("p", note, "muted"));
  parent.append(node); return node;
}
export function notice(parent, value, warning = false) { parent.append(el("p", value, `notice${warning ? " warning" : ""}`)); }
export function empty(parent, value) { parent.append(el("p", value, "empty")); }
export function heading(parent, title, note) {
  parent.append(el("h2", title));
  if (note) parent.append(el("p", note, "subtitle"));
}
export function metric(parent, entries) {
  const grid = el("dl", undefined, "metrics");
  for (const [label, value, note] of entries) {
    const item = el("div", undefined, "metric"), title = el("dt", label); title.title = label;
    item.append(title, el("dd", value));
    if (note) item.append(el("small", note)); grid.append(item);
  }
  parent.append(grid);
}
export function table(parent, headers, rows) {
  if (!rows.length) { empty(parent, "No matching records in this snapshot."); return; }
  const wrapper = el("div", undefined, "scroll-table"), node = el("table"), head = el("thead"), header = el("tr"), body = el("tbody");
  for (const title of headers) header.append(el("th", title));
  head.append(header);
  for (const row of rows) {
    const tr = el("tr");
    for (const value of row) {
      const td = el("td");
      if (value instanceof Node) td.append(value); else td.textContent = value ?? "Not recorded";
      tr.append(td);
    }
    body.append(tr);
  }
  node.append(head, body); wrapper.append(node); parent.append(wrapper);
}
export function choose(parent, label, options, value, update) {
  const wrap = el("label", label), select = el("select");
  for (const [key, title] of options) { const option = el("option", title); option.value = key; select.append(option); }
  select.value = value;
  select.addEventListener("change", () => update(select.value));
  wrap.append(select); parent.append(wrap); return select;
}
export function search(parent, placeholder, update) {
  const input = el("input"); input.type = "search"; input.placeholder = placeholder; input.setAttribute("aria-label", placeholder);
  input.addEventListener("input", () => update(input.value.toLowerCase())); parent.append(input); return input;
}
export function svgNode(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
