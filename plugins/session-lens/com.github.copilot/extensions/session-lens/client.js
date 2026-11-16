import { fmt, exact, date, ms, el, button, section, notice, empty, heading, metric, table, choose, search, svgNode, icon } from "./ui.mjs";
import { renderContext, renderComposition } from "./context-view.mjs";
import { renderActivity, initialActivityState, rangeTitle, selectedRange } from "./activity-view.mjs";
import { sessionFocus, focusMatcher } from "./activity.mjs";

const $ = (selector) => document.querySelector(selector);
$("#refresh").replaceChildren(icon("refresh"));
$("#refresh").setAttribute("aria-label", "Refresh"); $("#refresh").title = "Refresh";
$("#refresh").classList.add("icon-button");
const optionsToggle = document.querySelector(".view-options > summary");
optionsToggle.replaceChildren(icon("settings")); optionsToggle.setAttribute("aria-label", "View options"); optionsToggle.title = "View options";
optionsToggle.classList.add("icon-button");
const state = { tab: "overview", sessions: [], selected: null, snapshot: null, detail: null, busy: false, historyMode: "total", granularity: "request", activity: initialActivityState(), origin: null };
let activityView, initialized = false, scanRunning = false, scanGeneration = 0;
let requestQueue = Promise.resolve();
const outcome = (tool) => !tool.completeLine ? "Incomplete" : tool.success === true ? "Success" : tool.success === false ? "Failed" : "Unknown";
function error(error) { $("#error").hidden = false; $("#error").textContent = error.message; }
function api(path) {
  const result = requestQueue.then(async () => {
    const response = await fetch(path, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "The local source could not be read.");
    return data;
  });
  // Keep requests serialized without swallowing the caller's error.
  requestQueue = result.then(() => {}, () => {});
  return result;
}
async function run(fn) {
  if (state.busy) return;
  state.busy = true; $("#refresh").disabled = true; $("#error").hidden = true;
  try { await fn(); }
  catch (failure) { error(failure); }
  finally { state.busy = false; $("#refresh").disabled = false; }
}
function status() {
  const snapshot = state.snapshot;
  $("#status").textContent = state.tab === "overview"
    ? `${state.activity.complete ? "Updated" : state.activity.paused ? "Scan paused" : "Scanning"}${state.activity.readAt ? ` ${date(state.activity.readAt)}` : ""} · ${state.activity.scanned} session logs`
    : snapshot
    ? `Updated ${date(snapshot.readAt)} · ${fmt(snapshot.counts.events)} events${snapshot.coverage.complete ? "" : " · Partial coverage"}`
    : "Local session files · Read-only · No model calls";
}
function renderSessions() {
  const needle = $("#session-search").value.toLowerCase();
  const list = $("#sessions"); list.replaceChildren();
  for (const item of state.sessions.filter((item) => item.id.toLowerCase().includes(needle))) {
    const node = button("", () => run(async () => {
      state.origin = { label: rangeTitle(state.activity) };
      await loadSession(item.id); await openTab("session"); $("#session-picker").open = false;
    }), "session-item");
    node.setAttribute("aria-pressed", String(item.id === state.selected));
    node.title = item.id;
    node.append(el("span", item.id.slice(0, 18), "mono"), el("small", date(item.updatedAt)));
    list.append(node);
  }
  if (!list.childElementCount) empty(list, "No matching sessions.");
}
async function loadSession(id, refresh = false) {
  if (id !== state.selected) state.context = {};
  state.snapshot = await api(`/api/session?id=${encodeURIComponent(id)}${refresh ? "&refresh=1" : ""}`);
  state.selected = id;
  $("#selected-session").textContent = `${state.snapshot.title || state.snapshot.workspace || id.slice(0, 8)} · ${date(state.snapshot.firstEventAt)}`;
  if (state.origin?.focus && !refresh) {
    const focus = state.origin.focus;
    state.context = { ...sessionFocus(state.snapshot.contextView.history, focus), focus, primitive: state.origin.primitive ?? null };
    state.origin.hasContextMatch = Boolean(state.context.pinned);
  }
  renderSessions(); render(); status();
  if (state.tab !== "overview" && !$("#quick-panel").hidden) renderQuick();
}
async function openTab(tab) {
  state.tab = tab;
  if (tab === "overview") {
    $("#quick-panel").hidden = true;
    await api("/api/navigation?view=activity");
  }
  render(); status();
  if (tab === "overview") {
    requestAnimationFrame(() => {
      const node = state.activity.focusSession
        ? [...document.querySelectorAll(".activity-session-name button")].find((node) => node.title === state.activity.focusSession) : null;
      node?.focus({ preventScroll: true });
      window.scrollTo(0, state.activity.scrollY);
    });
    void scanActivity();
  }
}

async function scanActivity() {
  if (scanRunning || state.activity.complete || state.activity.paused || state.tab !== "overview") return;
  scanRunning = true;
  const generation = scanGeneration;
  try {
    while (generation === scanGeneration && state.tab === "overview" && !state.activity.paused && !state.activity.complete) {
      const data = state.activity;
      const params = new URLSearchParams({ timeZone: data.timeZone, offset: String(data.offset), historyDays: data.limitHistory ? "30" : "0" });
      if (data.scanId) params.set("scanId", data.scanId);
      const batch = await api(`/api/overview?${params}`);
      if (generation !== scanGeneration) break;
      data.scanBuffer ??= [];
      data.scanFailures ??= [];
      data.scanBuffer.push(...batch.sessions); data.scanFailures.push(...batch.failures);
      Object.assign(data, { available: batch.available, scanned: batch.scanned, scanId: batch.scanId, offset: batch.nextOffset,
        complete: batch.nextOffset === null, unreadable: batch.unreadable, excluded: batch.excluded, cutoff: batch.cutoff });
      if (!data.refreshing || data.complete) {
        data.sessions = [...data.scanBuffer]; data.failures = [...data.scanFailures]; data.readAt = batch.readAt;
      }
      if (data.complete) { data.refreshing = false; data.scanBuffer = null; data.scanFailures = null; }
      if (state.tab === "overview") activityView?.update({ progressOnly: data.refreshing });
      status();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (failure) {
    if (generation === scanGeneration) { state.activity.paused = true; error(failure); activityView?.update(); }
  } finally {
    scanRunning = false;
    if (generation !== scanGeneration) void scanActivity();
  }
}

function navigation() {
  const overview = state.tab === "overview";
  $("#session-picker").hidden = overview;
  $("#quick").hidden = overview;
  $("#tabs").hidden = overview;
  $("#session-breadcrumb").hidden = overview;
  $("#activity-home").hidden = overview;
  if (!overview) {
    $("#back-to-activity").textContent = state.origin ? `Activity · ${state.origin.label}` : "Activity";
    $("#session-scope").textContent = state.origin?.summary
      ? `${state.origin.summary} in ${state.origin.label} · Full history${state.origin.hasContextMatch ? ", focused on this interval" : state.origin.focus ? "; no retained context steps in this interval" : ""}`
      : "Full session history";
    $("#session-scope").title = $("#session-scope").textContent;
  }
  for (const node of $("#tabs").children) {
    if (node.dataset.tab === state.tab) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  }
}
function sourceButton(line, label = `Line ${line}`) { return button(label, () => run(() => openDetail(line)), "link"); }
async function openDetail(line) {
  state.detail = line;
  const record = state.snapshot.events.find((event) => event.line === line);
  $("#detail-title").textContent = record?.type ?? "Event evidence";
  $("#detail-meta").textContent = `events.jsonl · line ${line}${record ? ` · ${date(record.timestamp)} · ${record.bytes.toLocaleString()} bytes` : ""}`;
  $("#detail-content").textContent = "Content hidden. Enable the local preview to inspect this record.";
  if (!$("#detail").open) $("#detail").showModal();
  if ($("#reveal").checked) await revealDetail();
}
async function revealDetail() {
  const request = ++previewVersion;
  if (!$("#reveal").checked) { $("#detail-content").textContent = "Content hidden."; return; }
  $("#detail-content").textContent = "Reading this event locally...";
  const value = await api(`/api/detail?id=${encodeURIComponent(state.selected)}&line=${state.detail}&reveal=1`);
  if (request === previewVersion && $("#reveal").checked && $("#detail").open) {
    $("#detail-content").textContent = value.content + (value.truncated ? "\n\n[Preview limited to 24,000 characters]" : "");
  }
}
let previewVersion = 0;
function renderQuick() {
  const target = $("#quick-panel"); target.replaceChildren();
  const point = state.snapshot?.contextView.history.filter((point) => point.agent === "main").at(-1) ?? state.snapshot?.contextView.history.at(-1);
  if (point) renderComposition(target, { ...point, composition: point.observed }, () => {});
  else empty(target, "Select a session with recorded content.");
}
function renderSession(parent) {
  state.context ??= {};
  renderContext(parent, state.snapshot, state.context, {
    evidence: (line) => run(() => openDetail(line)),
    detail: (line) => api(`/api/detail?id=${encodeURIComponent(state.selected)}&line=${line}&reveal=1`),
    navigate: (tab) => run(() => openTab(tab)),
  });
}
function chart(parent, rows, mode = "total") {
  if (!rows.some((row) => row.inputTokens !== null || row.outputTokens !== null)) { empty(parent, "No recorded token measurements to chart."); return; }
  const svg = svgNode("svg", { viewBox: "0 0 760 170", class: "chart", role: "img", "aria-label": mode === "delta" ? "Change in request token traffic" : "Recorded request token traffic" });
  const values = rows.flatMap((row) => [row.inputTokens, row.outputTokens]).filter((value) => value !== null);
  const max = Math.max(1, ...values.map(Math.abs));
  const baseline = mode === "delta" ? 85 : 145;
  const amplitude = mode === "delta" ? 64 : 120;
  const x = (index) => 50 + index / Math.max(1, rows.length - 1) * 690;
  const y = (value) => baseline - value / max * amplitude;
  svg.append(svgNode("line", { x1: 45, y1: baseline, x2: 748, y2: baseline, class: "grid" }));
  const label = svgNode("text", { x: 2, y: 18 }); label.textContent = fmt(max); svg.append(label);
  for (const [key, className] of [["inputTokens", "input"], ["outputTokens", "output"]]) {
    let segment = [];
    const flush = () => { if (segment.length) svg.append(svgNode("polyline", { points: segment.join(" "), class: className })); segment = []; };
    rows.forEach((row, index) => {
      if (row[key] === null) flush(); else segment.push(`${x(index)},${y(row[key])}`);
    }); flush();
  }
  rows.forEach((row, index) => {
    if (row.inputTokens === null) return;
    const point = svgNode("circle", { cx: x(index), cy: y(row.inputTokens), r: rows.length < 50 ? 3 : 1.8, class: "point" });
    const title = svgNode("title"); title.textContent = `${date(row.timestamp)} · input ${exact(row.inputTokens)} · output ${exact(row.outputTokens)}`; point.append(title);
    point.addEventListener("click", () => { if (row.line) void run(() => openDetail(row.line)); });
    svg.append(point);
  });
  parent.append(svg);
  const legend = el("div", undefined, "legend"); legend.append(el("span", "Input", "input"), el("span", "Output", "output"), el("span", "Hover to inspect; select a row for source evidence.")); parent.append(legend);
}
function renderHistory(parent) {
  const s = state.snapshot;
  heading(parent, "Request history", "Actual recorded traffic, not a reconstruction of context occupancy.");
  const controls = el("div", undefined, "filters"); parent.append(controls);
  choose(controls, "Group", [["request", "Request"], ["turn", "User turn"]], state.granularity, (value) => { state.granularity = value; render(); });
  choose(controls, "Show", [["total", "Absolute"], ["delta", "Signed change"]], state.historyMode, (value) => { state.historyMode = value; render(); });
  let rows = s.timeline;
  if (state.granularity === "turn") {
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row.turn) ?? { ...row, inputTokens: 0, outputTokens: 0, duration: 0 };
      for (const key of ["inputTokens", "outputTokens", "duration"]) group[key] = row[key] === null || group[key] === null ? null : group[key] + row[key];
      groups.set(row.turn, group);
    }
    rows = [...groups.values()];
  }
  if (state.historyMode === "delta") rows = rows.map((row, index, list) => ({ ...row,
    inputTokens: index && row.inputTokens !== null && list[index - 1].inputTokens !== null ? row.inputTokens - list[index - 1].inputTokens : null,
    outputTokens: index && row.outputTokens !== null && list[index - 1].outputTokens !== null ? row.outputTokens - list[index - 1].outputTokens : null,
  }));
  chart(parent, rows.slice(-200), state.historyMode);
  parent.append(el("p", `Chart: last ${Math.min(rows.length, 200)} measurements. Negative change means less traffic than the prior ${state.granularity}, not proof of removed context.`, "muted"));
  const focused = state.origin?.focus ? rows.filter((row) => focusMatcher(state.origin.focus)(row.timestamp)) : [];
  if (state.origin?.focus) parent.append(el("p", focused.length ? `Focused on ${state.origin.label}` : `No retained request rows in ${state.origin.label}; showing recent history.`, "muted"));
  table(section(parent, "Recorded measurements"), ["Evidence", "Time", "Turn", "Model", "Input", "Output", "Duration", "First token"], (focused.length ? focused : rows).slice(-100).reverse().map((row) =>
    [sourceButton(row.line), date(row.timestamp), row.turn, row.model, fmt(row.inputTokens), fmt(row.outputTokens), ms(row.duration), ms(row.ttft)]));
  const changes = section(parent, "Context event markers");
  table(changes, ["Time", "Change", "Evidence"], s.markers.slice(-50).map((row) => [date(row.timestamp), row.type, sourceButton(row.line)]));
  notice(parent, "Exact prompt-order maps, context-category deltas, and reserve thresholds need assembled request snapshots. The Inspector shows recorded event order instead.");
}
function renderInspector(parent) {
  heading(parent, "Event inspector", "Explore recorded sequence and evidence. This is not the assembled model prompt.");
  const controls = el("div", undefined, "filters"); parent.append(controls);
  let needle = "", category = "all", order = "new", page = 0;
  const categories = [...new Set(state.snapshot.events.map((row) => row.category))];
  const body = el("div"); parent.append(body);
  const draw = () => {
    body.replaceChildren();
    let rows = state.snapshot.events.filter((row) => (category === "all" || row.category === category) && `${row.type} ${row.agent}`.toLowerCase().includes(needle));
    if (order === "new") rows = [...rows].reverse();
    const sequence = el("div", undefined, "sequence"); sequence.setAttribute("aria-label", "Recorded event sequence");
    for (const row of rows.slice(0, 180)) {
      const node = button("", () => run(() => openDetail(row.line))); node.dataset.category = row.category;
      node.title = `${row.type} · line ${row.line}`; node.setAttribute("aria-label", node.title); sequence.append(node);
    }
    body.append(sequence, el("p", `${rows.length.toLocaleString()} retained events match. Sequence width represents events, not tokens.`, "muted"));
    const slice = rows.slice(page * 75, (page + 1) * 75);
    table(body, ["Evidence", "Time", "Category", "Event", "Agent", "Bytes"], slice.map((row) =>
      [sourceButton(row.line), date(row.timestamp), row.category, row.type, row.agent, fmt(row.bytes)]));
    const pagination = el("div", undefined, "filters");
    const prev = button("Previous", () => { page--; draw(); }); prev.disabled = page === 0;
    const next = button("Next", () => { page++; draw(); }); next.disabled = (page + 1) * 75 >= rows.length;
    pagination.append(prev, el("span", `Page ${page + 1}`, "muted"), next); body.append(pagination);
  };
  search(controls, "Filter event type or agent", (value) => { needle = value; page = 0; draw(); });
  choose(controls, "Category", [["all", "All"], ...categories.map((name) => [name, name])], "all", (value) => { category = value; page = 0; draw(); });
  choose(controls, "Order", [["new", "Newest"], ["old", "Oldest / sequence"]], "new", (value) => { order = value; page = 0; draw(); });
  draw();
  notice(parent, "Reasoning, message text, arguments, results, and attachment metadata can be inspected with local reveal. Full system prompts/tool schemas and attachment previews are unavailable unless included in a recorded event. Content is never interpreted as instructions or rendered as HTML.");
}
function renderWork(parent) {
  const s = state.snapshot;
  heading(parent, "Work ledger", "Structural observations from recognized tools. Nothing here opens files or executes commands.");
  const files = section(parent, "File activity", "Paths are shown locally. Operations are requests, not proof of successful edits.");
  const fileControls = el("div", undefined, "filters"); files.append(fileControls);
  const fileBody = el("div"); files.append(fileBody);
  let fileQuery = "", kind = "all", sort = "latest";
  function drawFiles() {
    fileBody.replaceChildren();
    const groups = new Map();
    for (const row of s.files.filter((row) => (kind === "all" || kind === row.kind) && row.path.toLowerCase().includes(fileQuery))) {
      const group = groups.get(row.path) ?? { path: row.path, operations: [] };
      group.operations.push(row); groups.set(row.path, group);
    }
    const rows = [...groups.values()].sort((a, b) => sort === "count" ? b.operations.length - a.operations.length : sort === "path" ? a.path.localeCompare(b.path) : b.operations.at(-1).line - a.operations.at(-1).line);
    table(fileBody, ["Path", "Operations", "Kinds", "Evidence"], rows.slice(0, 150).map((group) => {
      const details = el("details"); details.append(el("summary", `${group.operations.length} recorded`));
      for (const op of group.operations) { const p = el("p"); p.append(sourceButton(op.line, `${op.kind} · line ${op.line}`)); details.append(p); }
      return [group.path, fmt(group.operations.length), [...new Set(group.operations.map((op) => op.kind))].join(", "), details];
    }));
    fileBody.append(el("p", `${rows.length} matching paths; showing up to 150. Search hits, final line deltas, image dimensions, and actual file contents are not inferred.`, "muted"));
  }
  search(fileControls, "Filter path", (value) => { fileQuery = value; drawFiles(); });
  choose(fileControls, "Operation", [["all", "All"], ["read", "Read"], ["search", "Search"], ["write", "Write"], ["edit", "Edit"]], "all", (value) => { kind = value; drawFiles(); });
  choose(fileControls, "Sort", [["latest", "Latest"], ["count", "Most operations"], ["path", "Path"]], "latest", (value) => { sort = value; drawFiles(); });
  drawFiles();
  const commands = section(parent, "Command executions", "Status describes the tool. A background shell may keep running after its launch tool completes.");
  const commandsControls = el("div", undefined, "filters"); commands.append(commandsControls);
  const commandsBody = el("div"); commands.append(commandsBody);
  let commandQuery = "", filter = "all", commandSort = "latest";
  const runs = s.tools.filter((tool) => tool.command);
  const counts = new Map();
  for (const tool of runs) counts.set(tool.command.program, (counts.get(tool.command.program) ?? 0) + 1);
  function drawCommands() {
    commandsBody.replaceChildren();
    const rows = runs.filter((tool) => tool.command.program.toLowerCase().includes(commandQuery) &&
      (filter === "all" || filter === "failed" && tool.success === false || filter === "slow" && tool.duration >= 10000 ||
       filter === "background" && tool.command.background || filter === "repeated" && counts.get(tool.command.program) > 1))
      .sort((a, b) => commandSort === "slow" ? (b.duration ?? -1) - (a.duration ?? -1) : b.line - a.line);
    table(commandsBody, ["Program", "Tool outcome", "Duration", "Launch", "Evidence", "Result"], rows.slice(0, 150).map((tool) =>
      [tool.command.program, outcome(tool), ms(tool.duration), tool.command.background ? "Background" : "Not marked background", sourceButton(tool.line), tool.completeLine ? sourceButton(tool.completeLine, "Inspect result") : "No completion"]));
    commandsBody.append(el("p", "Full commands, output, exit codes, and signals stay in the local event preview. Repetition counts program names, not identical command strings.", "muted"));
  }
  search(commandsControls, "Filter program", (value) => { commandQuery = value; drawCommands(); });
  choose(commandsControls, "Show", [["all", "All"], ["failed", "Failed"], ["slow", "10+ seconds"], ["background", "Background"], ["repeated", "Repeated program"]], "all", (value) => { filter = value; drawCommands(); });
  choose(commandsControls, "Sort", [["latest", "Latest"], ["slow", "Slowest"]], "latest", (value) => { commandSort = value; drawCommands(); });
  drawCommands();
}
function renderAgents(parent) {
  const s = state.snapshot;
  heading(parent, "Agent activity", "Recorded relationships, not a live fleet monitor. Child summary tokens are not added to session receipts.");
  const graph = el("div", undefined, "agent-tree");
  for (const agent of s.agents) {
    const node = el("div", undefined, "agent-node");
    const name = agent.name ?? (agent.id === "main" ? "Main agent" : agent.id);
    const owner = s.agents.find((item) => item.id === agent.parent);
    node.append(el("strong", name), el("p", agent.parent ? `From ${owner?.name ?? (owner?.id === "main" ? "Main agent" : agent.parent)}` : "Root / no parent recorded"),
      el("p", `${fmt(agent.tools)} tools · ${fmt(agent.events)} events`));
    if (agent.model) node.append(el("p", agent.model));
    if (agent.lastEvent) node.append(el("p", `${agent.lastEvent.replace("subagent.", "")} · ${fmt(agent.summaryTokens)} summary tokens`));
    node.append(button("Inspect context", () => run(async () => { state.context = { agent: agent.id }; await openTab("session"); }), "link"));
    graph.append(node);
  }
  parent.append(graph);
  const history = section(parent, "Collaboration timeline");
  const controls = el("div", undefined, "filters"); history.append(controls);
  const body = el("div"); history.append(body);
  let selected = "all";
  const draw = () => {
    body.replaceChildren();
    const rows = s.events.filter((event) => (event.category === "agents" || /task|agent/.test(s.tools.find((tool) => tool.line === event.line)?.name ?? "")) && (selected === "all" || event.agent === selected));
    table(body, ["Time", "Event", "Emitting agent", "Evidence"], rows.slice(-100).reverse().map((row) => [date(row.timestamp), row.type, row.agent, sourceButton(row.line)]));
  };
  choose(controls, "Emitting agent", [["all", "All"], ...s.agents.map((agent) => [agent.id, agent.id])], "all", (value) => { selected = value; draw(); });
  draw();
  notice(parent, "Team tasks, message contents, child-session links, and exact per-agent context require explicit recorded identities. Use delegation evidence when those fields exist; no relationships or completion states are guessed.");
}
function renderOverview(parent) {
  activityView = renderActivity(parent, state.activity, {
    toggleScan: () => {
      state.activity.paused = !state.activity.paused; activityView.update(); status();
      if (!state.activity.paused) void scanActivity();
    },
    openSession: (session) => run(async () => {
      state.activity.scrollY = window.scrollY; state.activity.focusSession = session.id;
      state.origin = { label: rangeTitle(state.activity), summary: `${session.usage.records} requests · ${fmt(session.tools)} tools`, focus: selectedRange(state.activity), primitive: state.activity.primitive };
      state.tab = "session";
      try { await loadSession(session.id); await openTab("session"); window.scrollTo(0, 0); }
      catch (failure) { state.tab = "overview"; render(); throw failure; }
    }),
    onRangeChange: status,
  });
}
function render() {
  navigation();
  const view = $("#view"); view.replaceChildren();
  if (state.tab === "overview") { renderOverview(view); return; }
  if (!state.snapshot) { heading(view, "Choose a session"); empty(view, "Select a local session to inspect its recorded activity."); return; }
  ({ session: renderSession, history: renderHistory, inspector: renderInspector, work: renderWork, agents: renderAgents })[state.tab](view);
}
async function refresh() {
  const remote = await api("/api/state");
  const listing = await api("/api/sessions"); state.sessions = listing.sessions;
  $("#session-count").textContent = `${listing.sessions.length}/${listing.total}`;
  if (!initialized) {
    initialized = true;
    state.tab = remote.view === "session" && remote.selected ? "session" : "overview";
  }
  if (state.tab === "overview") {
    startActivityScan();
  } else if (remote.selected) await loadSession(remote.selected, true);
  else { renderSessions(); render(); status(); }
  if (listing.unreadable) $("#status").textContent += ` · ${listing.unreadable} unreadable entries`;
}
function startActivityScan() {
  scanGeneration++;
  $("#error").hidden = true;
  Object.assign(state.activity, {
    scanId: null, offset: 0, scanned: 0, complete: false, paused: false, scanBuffer: [], scanFailures: [],
    refreshing: state.activity.sessions.length > 0,
  });
  renderSessions();
  if (state.tab === "overview") { render(); status(); void scanActivity(); }
}
$("#session-search").addEventListener("input", renderSessions);
$("#refresh").addEventListener("click", () => run(refresh));
$("#tabs").addEventListener("click", (event) => { if (event.target.dataset.tab) void run(() => openTab(event.target.dataset.tab)); });
$("#back-to-activity").addEventListener("click", () => run(() => openTab("overview")));
$("#activity-home").addEventListener("click", () => run(() => openTab("overview")));
$("#theme").addEventListener("change", (event) => { document.documentElement.dataset.theme = event.target.value; });
$("#history-limit").addEventListener("change", (event) => {
  state.activity.limitHistory = event.target.checked; state.activity.day = null; state.activity.hour = null;
  startActivityScan();
});
$("#quick").addEventListener("click", () => { $("#quick-panel").hidden = !$("#quick-panel").hidden; if (!$("#quick-panel").hidden) renderQuick(); });
$("#close-detail").addEventListener("click", () => $("#detail").close());
$("#reveal").addEventListener("change", () => { void revealDetail().catch(error); });
$("#detail").addEventListener("close", () => { previewVersion++; $("#reveal").checked = false; $("#detail-content").textContent = "Content hidden."; });
setInterval(() => { if ($("#auto").checked && !document.hidden && !$("#detail").open && !scanRunning && (state.tab !== "overview" || state.activity.complete)) void run(refresh); }, 10000);
void run(refresh);
