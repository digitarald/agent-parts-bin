import { dayFormatter, shiftDay, resolveRange, rangeDays, rangeHours, summarizeActivity, USAGE_KEYS } from "./activity.mjs";
import { el, button, choose, search, metric, table, fmt, date, svgNode, empty, disclosure, help, iconButton } from "./ui.mjs";
import { matchesPrimitive, primitiveLabel } from "./primitives.mjs";
import { renderPrimitives } from "./primitives-view.mjs";

export const RANGE_NAMES = { today: "Today", yesterday: "Yesterday", "7": "Last 7 days", "30": "Last 30 days", all: "All dates", custom: "Custom range" };
export function rangeTitle(state) {
  if (state.hour) return `${displayDay(state.day ?? resolveRange(state.selection, state.timeZone).from)} · ${state.hour.replace("@", ":00 ")}`;
  if (state.day) return displayDay(state.day);
  if (state.selection.preset === "all" && state.limitHistory) return "Available history";
  if (state.selection.preset === "custom") return state.selection.from === state.selection.to ? displayDay(state.selection.from) : `${displayDay(state.selection.from)} – ${displayDay(state.selection.to)}`;
  return RANGE_NAMES[state.selection.preset];
}
function displayDay(day) {
  if (!day) return "";
  const currentYear = new Date().getFullYear();
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(Number(day.slice(0, 4)) !== currentYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}
export function selectedRange(state) {
  const range = resolveRange(state.selection, state.timeZone);
  const cutoff = state.limitHistory ? shiftDay(dayFormatter(state.timeZone)(new Date()), -29) : null;
  return { from: state.day ?? (!range.from || cutoff && range.from < cutoff ? cutoff : range.from), to: state.day ?? range.to, timeZone: state.timeZone, hour: state.hour };
}
function panel(parent, title, note) {
  const node = el("section", undefined, "lens-panel");
  const head = el("div", undefined, "panel-heading");
  head.append(el("h3", title));
  if (note) head.append(el("span", note, "muted"));
  node.append(head); parent.append(node); return node;
}
const traffic = (usage) => usage.inputTokens === null && usage.outputTokens === null ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
const axisNumber = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function renderActivity(parent, state, actions) {
  const heading = el("div", undefined, "activity-heading");
  heading.append(el("div"));
  heading.firstChild.append(el("h2", "Activity"));
  const controls = el("div", undefined, "range-controls");
  controls.setAttribute("role", "group"); controls.setAttribute("aria-label", "Activity date range");
  const presetButtons = [];
  for (const [preset, label] of [["today", "Today"], ["yesterday", "Yesterday"], ["7", "7 days"], ["30", "30 days"], ["all", "All dates"], ["custom", "Custom"]]) {
    const node = button(label, () => {
      if (preset === "custom" && !state.selection.from) {
        const previous = resolveRange(state.selection, state.timeZone);
        state.selection.from = previous.from ?? previous.to; state.selection.to = previous.to;
      }
      state.selection.preset = preset; state.day = null; state.hour = null; state.zoom = []; state.page = 0; updateControls(); draw();
    });
    node.dataset.preset = preset; presetButtons.push(node); controls.append(node);
  }
  heading.append(controls); parent.append(heading);
  const dateControls = el("div", undefined, "custom-range");
  const fromLabel = el("label", "From"), toLabel = el("label", "To");
  const from = el("input"), to = el("input"); from.type = to.type = "date";
  fromLabel.append(from); toLabel.append(to); dateControls.append(fromLabel, toLabel); parent.append(dateControls);
  from.addEventListener("change", () => { state.selection.from = from.value; state.day = null; state.hour = null; state.page = 0; draw(); });
  to.addEventListener("change", () => { state.selection.to = to.value; state.day = null; state.hour = null; state.page = 0; draw(); });
  const rangeInfo = el("div", undefined, "activity-range-info");
  const rangeLabel = el("span"), zoneLabel = el("span", "Local time", "muted");
  zoneLabel.title = state.timeZone.replaceAll("_", " "); zoneLabel.setAttribute("aria-label", `Time zone: ${state.timeZone}`);
  const focusChip = el("span", undefined, "range-focus"), limitLabel = el("span", undefined, "muted");
  rangeInfo.append(rangeLabel, focusChip, zoneLabel, limitLabel); parent.append(rangeInfo);
  const progress = el("div", undefined, "activity-progress");
  const progressText = el("span"); progressText.setAttribute("role", "status");
  const pause = button("Pause scan", () => actions.toggleScan(), "link");
  const warnings = el("details");
  warnings.append(disclosure("Coverage", "info", "Data coverage"));
  const warningsText = el("div"); warnings.append(warningsText);
  progress.append(progressText, pause, warnings); parent.append(progress);
  const invalid = el("p", undefined, "range-error"); invalid.setAttribute("role", "alert"); invalid.hidden = true; parent.append(invalid);
  const body = el("div"); parent.append(body);

  function updateControls() {
    for (const node of presetButtons) {
      node.setAttribute("aria-pressed", String(node.dataset.preset === state.selection.preset));
      if (node.dataset.preset === "all") node.textContent = state.limitHistory ? "Available history" : "All dates";
    }
    dateControls.hidden = state.selection.preset !== "custom";
    from.value = state.selection.from ?? ""; to.value = state.selection.to ?? "";
  }
  function draw({ progressOnly = false } = {}) {
    const focus = document.activeElement;
    const searchFocused = focus?.getAttribute("aria-label") === "Filter sessions or models";
    const caret = searchFocused ? focus.selectionStart : null;
    const sortingFocused = body.contains(focus) && focus?.tagName === "SELECT";
    updateControls();
    let range;
    try { range = resolveRange(state.selection, state.timeZone); }
    catch (error) { invalid.textContent = error.message; invalid.hidden = false; body.replaceChildren(); return; }
    invalid.hidden = true;
    const cutoff = state.limitHistory ? shiftDay(dayFormatter(state.timeZone)(new Date()), -29) : null;
    const outside = cutoff && (state.day ?? range.to) < cutoff;
    const clipped = cutoff && (!range.from || range.from < cutoff);
    if (clipped) range = { ...range, from: cutoff };
    const complete = state.complete;
    const indexed = state.scanned ?? 0, available = state.available;
    const partialFiles = state.sessions.filter((session) => !session.coverage.complete).length;
    progressText.textContent = available == null ? "Reading local session index..." :
      `${complete ? "Scanned" : state.paused ? "Paused at" : state.refreshing ? "Refreshing" : "Scanning"} ${indexed.toLocaleString()} of ${available.toLocaleString()} session logs${state.refreshing ? " · showing previous snapshot" : complete ? "" : " · totals so far"}${partialFiles ? ` · ${partialFiles} partial logs` : ""}${state.failures.length ? ` · ${state.failures.length} read failures` : ""}`;
    pause.hidden = complete || available == null;
    pause.textContent = state.paused ? "Continue scan" : "Pause scan";
    rangeLabel.textContent = state.selection.preset === "all" && cutoff ? "Available history" : RANGE_NAMES[state.selection.preset];
    if (range.from && range.from !== range.to) rangeLabel.textContent += ` · ${displayDay(range.from)} – ${displayDay(range.to)}`;
    focusChip.replaceChildren();
    if (state.day || state.hour) focusChip.append(button(`${rangeTitle(state)} ×`, () => { state.day = null; state.hour = null; state.page = 0; draw(); }, "focus-chip"));
    if (state.zoom.length) focusChip.append(button("Back to wider range", () => { const previous = state.zoom.pop(); Object.assign(state, previous); state.page = 0; draw(); }, "link"));
    limitLabel.textContent = cutoff ? `Last 30 days${state.excluded ? ` · ${state.excluded.toLocaleString()} older log${state.excluded === 1 ? "" : "s"} excluded` : ""}` : "Full archive";
    if (outside) {
      body.replaceChildren(el("h3", "Outside the history limit"), el("p", "Turn off the 30-day limit in View options to explore these dates.", "muted"));
      return;
    }
    if (progressOnly && body.childElementCount) return;
    const result = summarizeActivity(state.sessions, range, state.day, state.hour);
    warningsText.replaceChildren(el("p", "Events and receipts are assigned to calendar days in the time zone shown. Rows, totals, and rankings cover this range only."));
    warningsText.append(el("p", `${state.failures.length} read failures · ${state.unreadable ?? 0} unreadable index entries · ${state.sessions.filter((session) => !session.coverage.complete).length} partial logs.`));
    if (state.failures.length) warningsText.append(el("p", state.failures[0].error));
    warningsText.append(el("p", "The 30-day limit skips files last modified before the cutoff and filters retained events by date. An old session active recently is still included. File timestamps can be preserved when logs are copied; disable the limit to include those files. Rotated, capped, or undated records leave gaps."));
    warningsText.append(el("p", "Workspace labels come from recorded session metadata and stay local. Usage is observed session traffic, not deduplicated account billing."));
    body.replaceChildren();
    if (!result.sessions.length) {
      const statePanel = panel(body, complete ? "No activity in this range" : state.refreshing ? "Updating this range" : "Looking for activity");
      empty(statePanel, complete ? "Try another date range or check the history limit." : "No matching activity in the logs scanned so far. This is not a zero-usage result.");
      return;
    }
    const totals = result.total;
    const missingTokens = USAGE_KEYS.some((key) => totals.usage.missing[key] > 0);
    const noUsage = result.sessions.filter((session) => !session.usage.records).length;
    const metrics = [
      ["Sessions", fmt(result.sessions.length)],
      ["Input tokens", totals.usage.inputTokens == null ? null : fmt(totals.usage.inputTokens)],
      ["Output tokens", totals.usage.outputTokens == null ? null : fmt(totals.usage.outputTokens)],
      ["Skill invocations", fmt(totals.skills)],
      ["MCP calls", fmt(totals.rankings.mcps.reduce((sum, entry) => sum + entry.count, 0))],
    ].filter((entry) => entry[1] !== null);
    const top = panel(body, "In this range", state.refreshing ? "Previous snapshot" : complete ? "Recorded activity" : "Totals so far");
    top.classList.add("activity-summary");
    metric(top, metrics);
    const notes = el("div", undefined, "summary-footer");
    if (totals.usage.records) notes.append(el("span", `${fmt(totals.usage.records)} model requests`));
    if (totals.turns) notes.append(el("span", `${fmt(totals.turns)} user input${totals.turns === 1 ? "" : "s"}`));
    if (totals.usage.inputTokens > 0 && totals.usage.cacheReadTokens !== null && !totals.usage.missing.cacheReadTokens && !totals.usage.missing.inputTokens) {
      notes.append(el("span", `${(totals.usage.cacheReadTokens / totals.usage.inputTokens * 100).toFixed(1)}% cache read`));
    }
    if (totals.failed) notes.append(el("span", `${fmt(totals.failed)} failed tool completions`));
    if (missingTokens || noUsage) notes.append(el("span", `Usage incomplete${noUsage ? ` in ${noUsage} sessions` : ""}`, "warning"));
    top.append(notes);
    const middle = el("div", undefined, "activity-middle"); body.append(middle);
    const chartRange = state.day ? { from: state.day, to: state.day } : range;
    const hourly = chartRange.from === chartRange.to;
    const overall = state.hour ? summarizeActivity(state.sessions, chartRange) : result;
    const buckets = hourly ? rangeHours(chartRange.from, state.sessions, state.timeZone) : rangeDays(chartRange, overall.days);
    const unit = buckets[0]?.unit ?? "day";
    const daily = panel(middle, ({ hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" })[unit] + " usage", "Input + output tokens");
    const svg = svgNode("svg", { viewBox: "0 0 800 180", class: "activity-chart", role: "group", "aria-label": "Usage by date; select a day or interval" });
    const peak = Math.max(1, ...buckets.map((bucket) => traffic(bucket.usage) ?? 0));
    for (let tick = 0; tick <= 3; tick++) {
      const y = 14 + tick * 42;
      svg.append(svgNode("line", { x1: 72, x2: 785, y1: y, y2: y, class: "chart-grid" }));
      const text = svgNode("text", { x: 64, y: y + 4, "text-anchor": "end" }); text.textContent = axisNumber.format(Math.round(peak * (1 - tick / 3))); svg.append(text);
    }
    const step = 710 / Math.max(1, buckets.length), barWidth = Math.min(52, step * .68);
    buckets.forEach((bucket, index) => {
      const x = 72 + step * index + (step - barWidth) / 2;
      const input = bucket.usage.inputTokens ?? 0, output = bucket.usage.outputTokens ?? 0;
      const bucketLabel = hourly ? bucket.label : `${displayDay(bucket.from)}${bucket.to !== bucket.from ? ` – ${displayDay(bucket.to)}` : ""}`;
      const noUsage = !bucket.usage.records;
      const description = bucket.future ? "Upcoming" : noUsage ? bucket.events ? "Usage not recorded" : complete ? "No recorded activity" : "Not yet observed" : `${fmt(traffic(bucket.usage))} tokens`;
      const group = svgNode("g", { tabindex: bucket.future ? -1 : 0, role: "button", "aria-label": `${bucketLabel}: ${description}, ${bucket.events} events`,
        "aria-pressed": String(hourly ? state.hour === bucket.key : state.day === bucket.from && bucket.from === bucket.to),
        "aria-disabled": String(Boolean(bucket.future)), "data-hour": bucket.key ?? "", class: `activity-day${bucket.future ? " future-hour" : ""}` });
      group.append(svgNode("rect", { x: x - 4, y: 10, width: barWidth + 8, height: 136, fill: "transparent", stroke: "none" }));
      let bottom = 140;
      for (const [value, color] of [[input, "var(--cat-results)"], [output, "var(--cat-assistant)"]]) {
        const height = value / peak * 126;
        bottom -= height;
        group.append(svgNode("rect", { x, y: bottom, width: barWidth, height, rx: 2, fill: color, stroke: "none" }));
      }
      if (!input && !output) group.append(svgNode("line", { x1: x, x2: x + barWidth, y1: 140, y2: 140, class: "chart-grid" }));
      const title = svgNode("title"); title.textContent = `${bucketLabel}\n${description}\nInput ${fmt(bucket.usage.inputTokens)} · Output ${fmt(bucket.usage.outputTokens)}\n${bucket.tools} tool calls`; group.append(title);
      const select = () => {
        if (bucket.future) return;
        if (hourly) state.hour = state.hour === bucket.key ? null : bucket.key;
        else if (bucket.from === bucket.to) { state.day = bucket.from; state.hour = null; }
        else {
          state.zoom.push({ selection: { ...state.selection }, day: state.day, hour: state.hour });
          state.selection = { preset: "custom", from: bucket.from, to: bucket.to }; state.day = null; state.hour = null;
        }
        state.page = 0; draw();
      };
      group.addEventListener("click", select);
      group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
      svg.append(group);
      if (index % Math.max(1, Math.ceil(buckets.length / 7)) === 0 || buckets.length === 1) {
        const label = svgNode("text", { x: x + barWidth / 2, y: 164, "text-anchor": "middle" });
        label.textContent = hourly ? `${bucket.hour}:00` : unit === "month" ? new Date(`${bucket.from}T12:00Z`).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }) : displayDay(bucket.from);
        svg.append(label);
      }
    });
    if (overall.total.usage.records) daily.append(svg);
    else empty(daily, "Activity is recorded, but token usage is missing. Inspect a session for the available events.");
    const legend = el("div", undefined, "activity-chart-legend");
    legend.append(el("span", "Input", "input-key"), el("span", "Output", "output-key"), el("span", hourly ? "Select an hour to focus" : unit === "day" ? "Select a day to focus" : "Select an interval to zoom in", "muted"));
    daily.append(legend);
    const calendar = el("details", undefined, "activity-calendar");
    calendar.open = Boolean(state.calendar);
    calendar.append(disclosure("Calendar", undefined, "Activity calendar · last 8 weeks"));
    calendar.addEventListener("toggle", () => { if (calendar.isConnected) state.calendar = calendar.open; });
    const heat = el("div", undefined, "heatmap");
    const today = dayFormatter(state.timeZone)(new Date()), eventsByDay = new Map();
    for (const session of state.sessions) for (const day of session.daily) eventsByDay.set(day.day, (eventsByDay.get(day.day) ?? 0) + day.events);
    for (let offset = 55; offset >= 0; offset--) {
      const day = shiftDay(today, -offset), count = eventsByDay.get(day) ?? 0;
      const cell = button("", () => {
        state.zoom.push({ selection: { ...state.selection }, day: state.day, hour: state.hour });
        state.selection = { preset: "custom", from: day, to: day }; state.day = null; state.hour = null; state.page = 0; draw();
      }, count > 100 ? "dense" : count ? "active" : "");
      cell.title = cutoff && day < cutoff ? `${day}: outside the 30-day history limit` : `${day}: ${count.toLocaleString()} recorded events`;
      cell.setAttribute("aria-label", cell.title); cell.disabled = Boolean(cutoff && day < cutoff);
      heat.append(cell);
    }
    calendar.append(heat); daily.append(calendar);
    const ranked = panel(middle, "Used in this range", "Select to find sessions");
    ranked.querySelector(".panel-heading > span").replaceWith(help("Select a model role, skill, or MCP to find sessions. Counts show recorded usage, not effectiveness."));
    renderPrimitives(ranked, totals.rankings, {
      compact: true, selected: state.primitive,
      sessionCounts: (filter) => result.sessions.filter((session) => matchesPrimitive(session.rankings, filter)).length,
      choose: (filter) => {
        state.primitive = JSON.stringify(state.primitive) === JSON.stringify(filter) ? null : filter;
        state.page = 0; draw();
        parent.querySelector(".activity-session-list")?.scrollIntoView({ block: "nearest", behavior: "instant" });
      },
    });
    const list = panel(body, "Sessions", "Open a session at the selected dates");
    list.classList.add("activity-session-list");
    if (state.primitive) {
      const selection = el("div", undefined, "primitive-selection");
      selection.append(el("span", `Sessions using ${primitiveLabel(state.primitive)}`),
        iconButton("Clear filter", "close", () => { state.primitive = null; state.page = 0; draw(); }));
      list.append(selection);
    }
    const filters = el("div", undefined, "filters");
    const listing = el("div");
    const drawList = () => {
      listing.replaceChildren();
      const rows = result.sessions.filter((session) => matchesPrimitive(session.rankings, state.primitive) &&
        `${session.id} ${session.title ?? ""} ${session.workspace ?? ""} ${session.rankings.models.map((item) => item.name).join(" ")}`.toLowerCase().includes(state.query))
        .sort((a, b) => state.sort === "tokens" ? (traffic(b.usage) ?? -1) - (traffic(a.usage) ?? -1) : state.sort === "tools" ? b.tools - a.tools : (b.lastEventAt ?? "").localeCompare(a.lastEventAt ?? ""));
      const pageSize = 20, lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
      if (!state.refreshing) state.page = Math.min(state.page, lastPage);
      if (!rows.length) {
        empty(listing, complete ? "No sessions match this range and filter." : "No matches in the logs scanned so far.");
      } else {
        table(listing, ["Session", "Last activity", "Requests", "Input", "Output", "Tools"], rows.slice(state.page * pageSize, (state.page + 1) * pageSize).map((session) => {
          const name = el("div", undefined, "activity-session-name");
          const label = session.title || session.workspace || `Session ${session.id.slice(0, 8)}`;
          const link = button(label, () => actions.openSession(session), "link"); link.title = session.id;
          name.append(link);
          if (session.title || session.workspace) name.append(el("small", `${session.title && session.workspace ? session.workspace + " · " : ""}${session.id.slice(0, 8)}`, "muted"));
          const models = session.rankings.models.map((item) => item.name).join(", ");
          if (models) { const label = el("small", models, "muted session-models"); label.title = models; name.append(label); }
          if (!session.coverage.complete) name.append(el("small", "Partial log", "warning"));
          return [name, date(session.lastEventAt), session.usage.records || "—",
            session.usage.inputTokens === null ? "—" : `${session.usage.missing.inputTokens ? "~" : ""}${fmt(session.usage.inputTokens)}`,
            session.usage.outputTokens === null ? "—" : `${session.usage.missing.outputTokens ? "~" : ""}${fmt(session.usage.outputTokens)}`, fmt(session.tools)];
        }));
      }
      const paging = el("div", undefined, "activity-pagination");
      const prev = button("Previous", () => { state.page--; drawList(); }); prev.disabled = state.page === 0;
      const next = button("Next", () => { state.page++; drawList(); }); next.disabled = state.page >= lastPage;
      paging.append(el("span", `${rows.length} sessions · all values in this range`, "muted"), prev, next); listing.append(paging);
    };
    const field = search(filters, "Filter sessions or models", (value) => { state.query = value; state.page = 0; drawList(); }); field.value = state.query;
    const sorting = choose(filters, "Sort", [["recent", "Recent activity"], ["tokens", "Most tokens"], ["tools", "Most tools"]], state.sort, (value) => { state.sort = value; state.page = 0; drawList(); });
    list.append(filters, listing); drawList();
    if (searchFocused) { field.focus({ preventScroll: true }); field.setSelectionRange(caret, caret); }
    if (sortingFocused) sorting.focus({ preventScroll: true });
    actions.onRangeChange();
  }
  draw();
  return { update: draw };
}

export function initialActivityState() {
  return {
    selection: { preset: "today" }, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    day: null, hour: null, zoom: [], query: "", sort: "recent", page: 0, sessions: [], failures: [], scanned: 0,
    available: null, complete: false, paused: false, scanId: null, offset: 0, limitHistory: true, refreshing: false,
    scrollY: 0, focusSession: null, primitive: null,
  };
}
