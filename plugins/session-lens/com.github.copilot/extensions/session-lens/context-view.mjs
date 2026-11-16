import { CATEGORIES, count, deltaParts } from "./tokens.mjs";
import { el, button, choose, search, metric, table, fmt, date, ms, svgNode, empty, disclosure, help, iconButton } from "./ui.mjs";
import { focusMatcher } from "./activity.mjs";
import { primitiveLabel } from "./primitives.mjs";
import { renderPrimitives } from "./primitives-view.mjs";

const tokenLabel = (tokens) => tokens?.value == null ? "" : `${["recorded", "derived"].includes(tokens.basis) ? "" : "~"}${fmt(tokens.value)}`;
const categoryName = (id) => CATEGORIES.find((category) => category.id === id)?.label ?? id;
const color = (id) => `var(--cat-${id})`;
function dot(id) { return el("span", "", `swatch cat-${id}`); }
function panel(parent, title, note) {
  const node = el("section", undefined, "lens-panel");
  const header = el("div", undefined, "panel-heading"); header.append(el("h3", title));
  if (note) header.append(el("span", note, "muted"));
  node.append(header); parent.append(node); return node;
}
function segmented(parent, label, options, value, select) {
  const group = el("div", undefined, "segmented"); group.setAttribute("role", "group"); group.setAttribute("aria-label", label);
  for (const [id, title] of options) {
    const node = button(title, () => select(id)); node.setAttribute("aria-pressed", String(value === id)); group.append(node);
  }
  parent.append(group);
}
function stack(parent, parts, select) {
  const total = parts.reduce((sum, part) => sum + (part.tokens.value ?? 0), 0);
  const svg = svgNode("svg", { viewBox: "0 0 1000 18", preserveAspectRatio: "none", class: "composition-bar", role: "group", "aria-label": "Token composition by category" });
  let x = 0;
  for (const part of parts) {
    if (!(part.tokens.value > 0) || !total) continue;
    const width = part.tokens.value / total * 1000;
    const rect = svgNode("rect", { x, y: 0, width, height: 18, fill: color(part.id), stroke: "none", tabindex: 0, role: "button", "aria-label": `${part.label}: ${tokenLabel(part.tokens)}` });
    const title = svgNode("title"); title.textContent = `${part.label}: ${tokenLabel(part.tokens)} · ${part.tokens.basis}`; rect.append(title);
    rect.addEventListener("click", () => select(part.id));
    rect.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(part.id); } });
    svg.append(rect); x += width;
  }
  parent.append(svg);
}
function legend(parent, parts, select) {
  const list = el("div", undefined, "composition-legend");
  const total = parts.reduce((sum, part) => sum + (part.tokens.value ?? 0), 0);
  for (const part of parts) {
    if (!(part.tokens.value > 0)) continue;
    const row = button("", () => select(part.id), "legend-row");
    row.title = `${part.tokens.basis}: ${part.tokens.method}`;
    const share = total ? part.tokens.value / total * 100 : 0;
    row.append(dot(part.id), el("span", part.label), el("strong", tokenLabel(part.tokens)), el("small", share > 0 && share < 1 ? "<1%" : `${Math.round(share)}%`));
    list.append(row);
  }
  parent.append(list);
}
export function renderComposition(parent, point, select) {
  const info = el("div", undefined, "composition-head");
  info.append(el("strong", tokenLabel(point.composition.total)), el("span", "tokens of recorded text", "muted"));
  parent.append(info);
  stack(parent, point.composition.parts, select);
  legend(parent, point.composition.parts, select);
}
function donut(parent, parts, label, value) {
  const known = parts.filter((part) => part.tokens.value > 0);
  const total = known.reduce((sum, part) => sum + part.tokens.value, 0);
  const svg = svgNode("svg", { viewBox: "0 0 120 120", class: "donut", role: "img", "aria-label": label });
  svg.append(svgNode("circle", { cx: 60, cy: 60, r: 45, class: "donut-track" }));
  let offset = 0;
  for (const part of known) {
    const length = part.tokens.value / total * 100;
    const circle = svgNode("circle", { cx: 60, cy: 60, r: 45, fill: "none", stroke: color(part.id), "stroke-width": 11,
      pathLength: 100, "stroke-dasharray": `${length} ${100 - length}`, "stroke-dashoffset": -offset, transform: "rotate(-90 60 60)" });
    const title = svgNode("title"); title.textContent = `${part.label}: ${tokenLabel(part.tokens)}`; circle.append(title); svg.append(circle); offset += length;
  }
  for (const [text, y, className] of [[value, 59, "donut-value"], [label, 76, "donut-label"]]) {
    const node = svgNode("text", { x: 60, y, "text-anchor": "middle", class: className }); node.textContent = text; svg.append(node);
  }
  parent.append(svg);
}
function itemsAt(snapshot, point) {
  return point.boundary === null ? [] : snapshot.contextView.items.filter((item) =>
    item.agent === point.agent && item.epoch === point.epoch && item.line <= point.boundary);
}

export function renderContext(parent, snapshot, state, actions) {
  const history = snapshot.contextView.history.filter((point) => point.observed.chartTotal > 0)
    .map((point) => ({ ...point, composition: point.observed }));
  const availableAgents = [...new Set([...snapshot.agents.map((agent) => agent.id), ...history.map((point) => point.agent)])];
  if (!availableAgents.includes(state.agent)) state.agent = availableAgents.includes("main") ? "main" : availableAgents[0];
  state.mode ??= "total"; state.group ??= "step"; state.overview ??= false; state.duration ??= true;
  state.flat ??= false; state.category ??= "all"; state.query ??= ""; state.sort ??= "new";
  const nameFor = (id) => id === "main" ? "Main agent" : snapshot.agents.find((agent) => agent.id === id)?.name || id;
  let points = history.filter((point) => point.agent === state.agent);
  if (state.group === "turn") {
    const groups = new Map(); for (const point of points) groups.set(point.turn, point); points = [...groups.values()];
  }
  let selected = points.find((point) => point.id === state.pinned) ?? points.at(-1);
  const refresh = () => { parent.replaceChildren(); renderContext(parent, snapshot, state, actions); };
  const toolbar = el("div", undefined, "context-toolbar");
  choose(toolbar, "Agent", availableAgents.map((id) => [id, nameFor(id)]), state.agent, (id) => { state.agent = id; state.pinned = null; state.end = null; refresh(); });
  if (selected && selected.model !== "Unknown model") toolbar.append(el("span", selected.model, "model-label"));
  const coverage = el("details", undefined, "coverage-menu");
  coverage.append(disclosure("Counts", "info", "About these numbers"),
    el("p", snapshot.contextView.method));
  for (const warning of snapshot.coverage.warnings) coverage.append(el("p", warning));
  coverage.append(el("p", `Content browser retains ${snapshot.contextView.items.length} items; ${snapshot.contextView.droppedItems} older items omitted. Snapshots can include estimates for older content whose details are no longer retained.`));
  toolbar.append(coverage); parent.append(toolbar);
  const inFocus = state.focus ? focusMatcher(state.focus) : null;
  if (inFocus) {
    const count = points.filter((point) => inFocus(point.timestamp)).length;
    const note = el("div", undefined, "context-date-focus");
    const label = el("span", count ? `${count} step${count === 1 ? "" : "s"} in selected dates` : "No retained steps in selected dates", "muted");
    label.title = "Matching steps are highlighted; full session history remains available.";
    note.append(label);
    if (!count) note.append(button("Inspect usage log", () => actions.navigate("history"), "link"));
    note.append(iconButton("Clear date highlight", "close", () => { state.focus = null; refresh(); }));
    parent.append(note);
  }

  const stats = el("div", undefined, "summary-pair"); parent.append(stats);
  const summary = panel(stats, "Session activity", "Includes delegated work");
  metric(summary, [["Turns", fmt(snapshot.counts.turns)], ["Requests", fmt(snapshot.usage.records)],
    ["Skill invocations", fmt(snapshot.counts.skills)], ["MCP calls", fmt(snapshot.primitives.mcps.reduce((sum, server) => sum + server.count, 0))]]);
  summary.append(el("p", `${snapshot.agents.length} agent${snapshot.agents.length === 1 ? "" : "s"} · ${fmt(snapshot.counts.tools)} total tool calls`, "footnote"));

  const usage = snapshot.usage;
  const cacheKnown = usage.uncachedInput !== null && !usage.partial;
  const parts = cacheKnown ? [
    { id: "user", label: "Uncached input", tokens: count(usage.uncachedInput, "derived") },
    { id: "results", label: "Cache read", tokens: count(usage.cacheReadTokens) },
    { id: "schemas", label: "Cache write", tokens: count(usage.cacheWriteTokens) },
    { id: "assistant", label: "Output", tokens: count(usage.outputTokens) },
  ] : [{ id: "results", label: "Input", tokens: count(usage.inputTokens) }, { id: "assistant", label: "Output", tokens: count(usage.outputTokens) }];
  const knownTraffic = parts.filter((part) => part.tokens.value !== null);
  const traffic = knownTraffic.length ? panel(stats, "Token traffic", cacheKnown && usage.inputTokens > 0 ? `${(usage.cacheReadTokens / usage.inputTokens * 100).toFixed(1)}% cache read` : "Recorded usage") : null;
  const trafficBody = el("div", undefined, "donut-row");
  if (traffic) {
    donut(trafficBody, knownTraffic, usage.partial ? "Observed" : "Total tokens", fmt(knownTraffic.reduce((sum, part) => sum + part.tokens.value, 0)));
    legend(trafficBody, knownTraffic, () => actions.navigate("history")); traffic.append(trafficBody);
  }
  const durations = snapshot.timeline.filter((point) => point.duration !== null);
  const timing = el("div", undefined, "summary-footer");
  if (durations.length) timing.append(el("span", `${ms(durations.reduce((sum, row) => sum + row.duration, 0) / durations.length)} mean request`));
  if (snapshot.counts.failed) timing.append(button(`${snapshot.counts.failed} tool failures`, () => actions.navigate("work"), "link"));
  summary.append(timing);
  if (traffic) traffic.append(el("p", "Input is counted on each request. Cache is included, not added.", "footnote"));
  const primitivePanel = panel(parent, "Usage");
  primitivePanel.classList.add("session-primitives");
  const primitiveControls = el("div", undefined, "primitive-scope");
  state.primitiveScope ??= "session";
  segmented(primitiveControls, "Usage attribution scope", [["session", "Whole session"], ["agent", "Selected agent"]], state.primitiveScope, (value) => { state.primitiveScope = value; refresh(); });
  primitiveControls.prepend(help("Skills are recorded invocations, not quality scores. MCP groups use explicit server metadata. Scope controls the lists below."));
  primitivePanel.querySelector(".panel-heading").append(primitiveControls);
  const primitiveRows = state.primitiveScope === "agent" ? snapshot.primitives.agents[state.agent] ?? { models: [], skills: [], mcps: [], tools: [] } : snapshot.primitives;
  renderPrimitives(primitivePanel, primitiveRows, {
    selected: state.primitive, compact: true,
    choose: (filter) => { state.primitive = JSON.stringify(state.primitive) === JSON.stringify(filter) ? null : filter; refresh(); },
  });
  if (state.primitive) {
    const selected = state.primitive;
    const heading = el("div", undefined, "primitive-selection");
    heading.append(el("strong", `${primitiveLabel(selected)} · evidence`),
      iconButton("Clear selection", "close", () => { state.primitive = null; refresh(); }));
    primitivePanel.append(heading);
    const evidence = snapshot.primitives.events.filter((event) => event.kind === selected.kind && event.name === selected.name &&
      (!selected.role || event.role === selected.role) && (!selected.tool || event.tool === selected.tool) &&
      (state.primitiveScope !== "agent" || event.agent === state.agent));
    table(primitivePanel, ["Time", "Agent", "Event", "Evidence"], evidence.slice(-10).reverse().map((event) =>
      [date(event.timestamp), event.agent === "main" ? "Main" : nameFor(event.agent), event.tool || event.type,
        button(`Line ${event.line}`, () => actions.evidence(event.line), "link")]));
    if (evidence.length >= 10 || snapshot.coverage.warnings.length) primitivePanel.append(el("p", "Showing retained recent events. Aggregate counts may include earlier events.", "footnote"));
  }
  if (!selected) { empty(parent, "No request or content observations in this session."); return; }

  const workbench = el("div", undefined, "context-workbench"); parent.append(workbench);
  const left = el("div", undefined, "context-charts"); workbench.append(left);
  const compositionPanel = panel(left, "Recorded content", "Estimated text size");
  const compositionBody = el("div"); compositionPanel.append(compositionBody);
  const trend = panel(left, "Content history");
  const controls = el("div", undefined, "trend-controls"); trend.append(controls);
  segmented(controls, "History grouping", [["step", "Step"], ["turn", "Turn"]], state.group, (value) => { state.group = value; state.end = null; refresh(); });
  segmented(controls, "History values", [["total", "Total"], ["delta", "Delta"]], state.mode, (value) => { state.mode = value; refresh(); });
  const chartOptions = el("details", undefined, "chart-options"); chartOptions.append(disclosure("Options", "settings", "Chart options"));
  const optionBody = el("div", undefined, "option-body"); chartOptions.append(optionBody); controls.append(chartOptions);
  for (const [key, title] of [["overview", "Overview"], ["adaptive", "Adaptive"], ["duration", "Duration"]]) {
    if (key === "duration" && !points.some((point) => point.duration !== null)) continue;
    const node = button(title, () => { state[key] = !state[key]; refresh(); });
    node.setAttribute("aria-pressed", String(Boolean(state[key]))); optionBody.append(node);
  }
  const chart = el("div", undefined, "trend-plot"); trend.append(chart);
  const brief = el("div", undefined, "step-brief"); trend.append(brief);
  const browser = panel(workbench, "Content browser");
  const browserControls = el("div", undefined, "browser-controls"); browser.append(browserControls);
  const picker = choose(browserControls, "Request", points.map((point, index) => [point.id, `${index + 1} · Turn ${point.turn} · ${date(point.timestamp)}`]),
    selected.id, (id) => { state.pinned = id; selected = points.find((point) => point.id === id); update(selected); });
  const flat = button("Sequence", () => { state.flat = !state.flat; flat.setAttribute("aria-pressed", String(state.flat)); renderBrowser(selected); });
  flat.setAttribute("aria-pressed", String(state.flat)); browserControls.append(flat);
  const browserFilter = el("div", undefined, "filters");
  const input = search(browserFilter, "Find a tool, message, or category", (value) => { state.query = value; renderBrowser(selected); }); input.value = state.query;
  choose(browserFilter, "Sort", [["new", "Newest"], ["size", "Largest"], ["name", "Name"]], state.sort, (value) => { state.sort = value; renderBrowser(selected); });
  browser.append(browserFilter);
  const localLabel = el("label", undefined, "check browser-reveal");
  const reveal = el("input"); reveal.type = "checkbox"; reveal.checked = Boolean(state.reveal);
  localLabel.append(reveal, document.createTextNode("Reveal content locally")); browser.append(localLabel);
  const browserBody = el("div", undefined, "context-browser-body"); browser.append(browserBody);
  let previewGeneration = 0;
  reveal.addEventListener("change", () => { state.reveal = reveal.checked; previewGeneration++; renderBrowser(selected); });

  function focusCategory(id) { state.category = state.category === id ? "all" : id; renderBrowser(selected); }
  function renderBrowser(point) {
    const generation = ++previewGeneration;
    browserBody.replaceChildren();
    const before = points[points.indexOf(point) - 1];
    const parts = point.composition.parts.filter((part) => part.tokens.value > 0);
    const all = itemsAt(snapshot, point);
    const note = el("div", undefined, "browser-caption");
    note.append(el("strong", `Step ${points.indexOf(point) + 1}`), el("span", date(point.timestamp), "muted")); browserBody.append(note);
    stack(browserBody, parts, focusCategory);
    if (state.category !== "all") browserBody.append(button(`Show all · ${categoryName(state.category)}`, () => { state.category = "all"; renderBrowser(point); }, "filter-reset"));
    let rows = all.filter((item) => (state.category === "all" || item.category === state.category) &&
      `${item.title} ${categoryName(item.category)}`.toLowerCase().includes(state.query));
    rows.sort((a, b) => state.sort === "size" ? (b.tokens.value ?? -1) - (a.tokens.value ?? -1) : state.sort === "name" ? a.title.localeCompare(b.title) : b.line - a.line);
    const rowFor = (item) => {
      const details = el("details", undefined, "content-item");
      const head = el("summary");
      head.append(dot(item.category), el("span", item.title, "item-title"));
      if (item.success === false) head.append(el("span", "Failed", "failure-label"));
      if (item.line > (before?.boundary ?? Infinity)) head.append(el("span", "new", "delta-label"));
      if (item.tokens.value !== null) head.append(el("span", tokenLabel(item.tokens), "item-tokens"));
      head.title = `${item.tokens.basis}: ${item.tokens.method}`; details.append(head);
      const body = el("div", undefined, "content-body");
      body.append(el("p", `Line ${item.line} · ${categoryName(item.category)} · ${item.tokens.method}`, "footnote"));
      if (item.attachments?.length) body.append(el("p", `${item.attachments.length} attachment(s) · media tokens unknown`, "footnote"));
      const preview = el("pre", item.unavailable || "Content hidden. Enable local reveal to inspect."); body.append(preview);
      body.append(button("View source event", () => actions.evidence(item.line), "link")); details.append(body);
      let loaded = false;
      details.addEventListener("toggle", () => {
        if (!details.open || loaded || !reveal.checked || item.unavailable) return;
        loaded = true; preview.textContent = "Reading local content...";
        void actions.detail(item.line).then((value) => {
          if (generation !== previewGeneration || !reveal.checked || !details.isConnected) return;
          let text = value.content;
          if (!value.truncated) {
            const data = JSON.parse(text);
            const content = item.category === "reasoning" ? data.reasoningText : item.category === "results" ? data.result?.content
              : item.category === "calls" ? data.arguments : data.content ?? data.summary;
            if (content !== undefined) text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
          }
          preview.textContent = text + (value.truncated ? "\n[Preview truncated]" : "");
        }).catch((failure) => {
          if (generation === previewGeneration && details.isConnected) { preview.textContent = failure.message; loaded = false; }
        });
      });
      return details;
    };
    if (state.flat) {
      const map = el("div", undefined, "item-map");
      for (const item of rows.slice(0, 160)) {
        const node = button("", () => { const target = browserBody.querySelector(`[data-item="${item.id}"]`); target?.scrollIntoView({ block: "nearest" }); }, `cat-${item.category}`);
        node.title = `${item.title}: ${tokenLabel(item.tokens)}`; node.setAttribute("aria-label", node.title); map.append(node);
      }
      browserBody.append(map, el("p", "Recorded sequence, not verified model reading order.", "footnote"));
      for (const item of rows.slice(0, 200)) { const row = rowFor(item); row.dataset.item = item.id; browserBody.append(row); }
    } else {
      for (const part of parts) {
        if (state.category !== "all" && state.category !== part.id) continue;
        const matches = rows.filter((item) => item.category === part.id);
        const group = el("details", undefined, "category-group"); group.open = state.category === part.id || state.category === "all" && part.id === "results";
        const head = el("summary"); head.append(dot(part.id), el("strong", part.label), el("span", `${matches.length} items`, "muted"),
          el("span", tokenLabel(part.tokens), "category-tokens"));
        head.title = part.tokens.method;
        const delta = before ? deltaParts(point.composition, before.composition).find((item) => item.id === part.id)?.value : null;
        if (delta) head.append(el("span", `${delta > 0 ? "+" : ""}${fmt(delta)}`, "delta-label"));
        group.append(head);
        for (const item of matches.slice(0, 100)) group.append(rowFor(item));
        if (!matches.length) group.append(el("p", part.id === "other" ? "Recorded tokens with no attributable content." : "No retained item bodies for this category at this point.", "footnote"));
        if (matches.length > 100) group.append(el("p", `Showing 100 of ${matches.length}; filter or use Largest.`, "footnote"));
        browserBody.append(group);
      }
    }
  }
  function update(point) {
    compositionBody.replaceChildren();
    renderComposition(compositionBody, point, focusCategory);
    brief.replaceChildren();
    const head = el("div", undefined, "brief-heading");
    head.append(el("strong", `Turn ${point.turn} · Step ${points.indexOf(point) + 1}`));
    const measured = [point.input !== null ? `Input ${fmt(point.input)}` : "", point.output !== null ? `Output ${fmt(point.output)}` : ""].filter(Boolean).join(" · ");
    if (measured) head.append(el("span", measured, "request-receipt")); brief.append(head);
    const previous = points[points.indexOf(point) - 1];
    const incoming = itemsAt(snapshot, point).filter((item) => item.line > (previous?.boundary ?? 0));
    for (const [label, line, text] of [
      ["User", point.userLine, point.userLine ? `User input · line ${point.userLine}` : "No linked user input"],
      ["In", incoming[0]?.line, `${incoming.length} observed additions · ${[...new Set(incoming.map((item) => categoryName(item.category)))].join(", ") || "No retained additions"}`],
      ["Response", point.responseLine ?? point.line, [point.output !== null ? `${fmt(point.output)} output tokens` : "", point.duration !== null ? ms(point.duration) : "", point.cacheRead !== null && point.input > 0 ? (point.cacheRead / point.input * 100).toFixed(1) + "% cache read" : ""].filter(Boolean).join(" · ") || "Inspect event"],
    ]) {
      const row = el("div", undefined, "brief-row"); row.append(el("span", label));
      row.append(line ? button(text, () => actions.evidence(line), "link") : el("span", text, "muted")); brief.append(row);
    }
    picker.value = point.id; renderBrowser(point);
    chart.querySelectorAll("[data-point]").forEach((node) => {
      node.classList.toggle("step-selected", node.dataset.point === point.id);
    });
    chart.querySelectorAll("[data-point]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.point === point.id)));
  }

  const end = Math.min(points.length, state.end ?? points.length);
  const shown = state.overview ? points : points.slice(Math.max(0, end - 48), end);
  const width = 720, height = 230, leftPad = 42, rightPad = 42, top = 18, bottom = 26;
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, class: "context-trend", role: "group", "aria-label": "Stacked context history; select a step to inspect" });
  const series = shown.map((point) => {
    const prior = points[points.indexOf(point) - 1];
    const parts = state.mode === "delta" ? deltaParts(point.composition, prior?.composition) : point.composition.parts.map((part) => ({ ...part, value: part.tokens.value }));
    return { point, parts, positive: parts.reduce((sum, part) => sum + Math.max(0, part.value ?? 0), 0), negative: parts.reduce((sum, part) => sum + Math.min(0, part.value ?? 0), 0) };
  });
  const peak = Math.max(1, ...series.map((row) => Math.max(row.positive, Math.abs(row.negative))));
  const plotHeight = height - top - bottom, baseline = state.mode === "delta" ? top + plotHeight / 2 : height - bottom;
  const amplitude = state.mode === "delta" ? plotHeight / 2 : plotHeight;
  for (let tick = 0; tick <= 4; tick++) {
    const y = top + tick * plotHeight / 4;
    svg.append(svgNode("line", { x1: leftPad, y1: y, x2: width - rightPad, y2: y, class: "chart-grid" }));
    const label = svgNode("text", { x: leftPad - 5, y: y + 4, "text-anchor": "end" });
    const fraction = state.mode === "delta" ? 1 - tick / 2 : 1 - tick / 4;
    label.textContent = state.adaptive ? `${Math.round(fraction * 100)}%` : fmt(peak * fraction); svg.append(label);
  }
  const barWidth = (width - leftPad - rightPad) / Math.max(1, shown.length);
  let durationPoints = [];
  const showDuration = state.duration && shown.some((point) => point.duration !== null);
  const durationMax = Math.max(1, ...shown.map((point) => point.duration ?? 0));
  series.forEach(({ point, parts, positive, negative }, index) => {
    const x = leftPad + index * barWidth;
    const scale = amplitude / (state.adaptive ? Math.max(1, positive, Math.abs(negative)) : peak);
    let up = baseline, down = baseline;
    const group = svgNode("g", { role: "button", tabindex: 0, "data-point": point.id, "aria-label": `Step ${points.indexOf(point) + 1}, ${tokenLabel(point.composition.total)} estimated text tokens`, "aria-pressed": String(point.id === selected.id) });
    if (inFocus) group.setAttribute("data-in-range", String(inFocus(point.timestamp)));
    for (const part of parts) {
      if (!part.value) continue;
      const h = Math.abs(part.value) * scale, y = part.value > 0 ? up - h : down;
      if (part.value > 0) up -= h; else down += h;
      const rect = svgNode("rect", { x, y, width: Math.max(.2, barWidth - (state.overview ? 0 : 1.5)), height: h, fill: color(part.id), stroke: "none" });
      rect.addEventListener("click", () => { state.category = part.id; });
      group.append(rect);
    }
    const hit = svgNode("rect", { x, y: top, width: barWidth, height: plotHeight, fill: "transparent", stroke: "none", class: "step-outline" });
    group.prepend(hit);
    if (inFocus?.(point.timestamp)) group.append(svgNode("line", { x1: x, x2: x + barWidth - 1, y1: height - bottom + 4, y2: height - bottom + 4, class: "date-focus-mark" }));
    group.addEventListener("mouseenter", () => update(point));
    group.addEventListener("focus", () => update(point));
    const pin = () => { state.pinned = point.id; selected = point; update(point); };
    group.addEventListener("click", pin);
    group.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); pin(); } });
    const title = svgNode("title"); title.textContent = `Recorded text estimate ${tokenLabel(point.composition.total)}${point.duration !== null ? ` · ${ms(point.duration)}` : ""}`; group.append(title); svg.append(group);
    if (point.duration !== null) durationPoints.push(`${x + barWidth / 2},${height - bottom - point.duration / durationMax * plotHeight}`);
    else if (durationPoints.length) {
      if (showDuration) svg.append(svgNode("polyline", { points: durationPoints.join(" "), class: "duration-line" })); durationPoints = [];
    }
    const prev = points[points.indexOf(point) - 1];
    const markers = snapshot.markers.filter((marker) => marker.agent === point.agent && marker.line > (prev?.line ?? 0) && marker.line <= point.line && marker.category === "context");
    if (markers.length) { const mark = svgNode("path", { d: `M${x + barWidth / 2} ${top}v-8`, class: "event-marker" }); svg.append(mark); }
    if (index % Math.max(1, Math.ceil(shown.length / 6)) === 0) {
      const label = svgNode("text", { x: x + barWidth / 2, y: height - 5, "text-anchor": "middle" }); label.textContent = String(points.indexOf(point) + 1); svg.append(label);
    }
  });
  if (showDuration && durationPoints.length) svg.append(svgNode("polyline", { points: durationPoints.join(" "), class: "duration-line" }));
  if (showDuration) { const label = svgNode("text", { x: width - rightPad + 4, y: top + 8 }); label.textContent = ms(durationMax); svg.append(label); }
  svg.addEventListener("mouseleave", () => update(selected)); chart.append(svg);
  if (!state.overview && points.length > 48) {
    const range = el("input"); range.type = "range"; range.min = Math.min(48, points.length); range.max = points.length; range.value = end;
    range.setAttribute("aria-label", "History window end");
    range.addEventListener("change", () => { state.end = Number(range.value); refresh(); }); chart.append(range);
  }
  chart.append(el("p", `${state.overview ? "All retained steps" : `Steps ${Math.max(1, end - 47)}–${end}`} · hover to preview, click to pin`, "chart-caption"));
  update(selected);

  const secondary = el("details", undefined, "secondary-details");
  secondary.append(disclosure("Events, files, and usage")); parent.append(secondary);
  const changes = panel(secondary, "Context events");
  const eventControls = el("div", undefined, "filters"); changes.append(eventControls);
  const eventBody = el("div"); changes.append(eventBody);
  const renderEvents = (kind) => {
    eventBody.replaceChildren();
    const rows = snapshot.markers.filter((row) => row.agent === state.agent && (kind === "all" || row.category === kind)).slice(-30).reverse();
    table(eventBody, ["Time", "Event", "Turn", "Evidence"], rows.map((row) => [date(row.timestamp), row.type, row.turn, button(`Line ${row.line}`, () => actions.evidence(row.line), "link")]));
  };
  choose(eventControls, "Show", [["all", "All"], ["context", "Compaction / model"], ["instructions", "Instructions"], ["skills", "Skills"]], "all", renderEvents); renderEvents("all");
  const work = panel(secondary, "Files & commands");
  const operations = ["read", "write", "edit", "search"].map((kind) => [kind, snapshot.files.filter((row) => row.kind === kind).length]);
  const links = el("div", undefined, "activity-tallies");
  for (const [label, value] of [...operations, ["commands", snapshot.tools.filter((tool) => tool.command).length]]) links.append(button(`${label} ${fmt(value)}`, () => actions.navigate("work"), "tally"));
  work.append(links);
  const recorded = panel(secondary, "Recorded usage");
  metric(recorded, [["Input tokens", usage.inputTokens], ["Output tokens", usage.outputTokens]].filter((entry) => entry[1] !== null).map(([label, value]) => [label, fmt(value)]));
  const models = el("details"); models.append(el("summary", "Usage by model"));
  table(models, ["Model", "Requests", "Input", "Output", "Cache read"], snapshot.models.map((model) => [model.model, fmt(model.records), fmt(model.inputTokens), fmt(model.outputTokens), fmt(model.cacheReadTokens)]));
  recorded.append(models);
}
