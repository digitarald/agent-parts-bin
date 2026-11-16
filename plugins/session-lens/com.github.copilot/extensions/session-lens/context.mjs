import { CATEGORIES, composition, contentComposition, count, estimateText, validCount } from "./tokens.mjs";

const str = (value, max = 120) => typeof value === "string" ? value.slice(0, max) : "";
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const jsonText = (value) => typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value);
const optional = (value) => validCount(value) ? value : null;
const ids = (data) => [data.apiCallId, data.providerCallId, data.serviceRequestId, data.model_call_id, data.request_id, data.github_request_id].filter((value) => typeof value === "string" && value);

export function createContextProjection(limit) {
  const agents = new Map();
  const items = [];
  const receipts = [];
  const snapshots = new Map();
  const calls = new Map();
  const skillReferences = new Set();
  let droppedItems = 0;
  let droppedRequests = 0;
  const bounded = (list, value) => {
    list.push(value);
    if (list.length > limit) { list.shift(); return true; }
    return false;
  };
  function agentFor(id) {
    if (!agents.has(id)) agents.set(id, { weights: {}, itemCount: 0, lastUser: null, epoch: 0, lastLine: 0, requests: new Map() });
    return agents.get(id);
  }
  function add(record, category, content, title, extra = {}) {
    const tokens = estimateText(content);
    if (tokens.value === 0 && !extra.keepEmpty) return;
    const state = agentFor(record.agent);
    if (tokens.value !== null) state.weights[category] = (state.weights[category] ?? 0) + tokens.value;
    state.itemCount++;
    const item = { id: `${record.line}:${category}:${state.itemCount}`, line: record.line, timestamp: record.timestamp,
      agent: record.agent, turn: record.turn, epoch: state.epoch, category, title, tokens, ...extra };
    if (bounded(items, item)) droppedItems++;
    if (category === "user") state.lastUser = record.line;
  }
  function visit(event, record) {
    const data = event.data;
    const state = agentFor(record.agent);
    const priorLine = state.lastLine;
    state.lastLine = record.line;
    if (event.type === "assistant.message") {
      for (const id of ids(data)) {
        if (!state.requests.has(id)) state.requests.set(id, { weights: { ...state.weights }, boundary: priorLine, epoch: state.epoch, userLine: state.lastUser, responseLine: record.line });
      }
      while (state.requests.size > limit) state.requests.delete(state.requests.keys().next().value);
      add(record, "assistant", typeof data.content === "string" ? data.content : undefined, "Assistant answer");
      if (typeof data.reasoningText === "string" && data.reasoningText.length) add(record, "reasoning", data.reasoningText, "Reasoning text");
      else if (data.reasoningOpaque || data.encryptedContent) add(record, "reasoning", undefined, "Opaque reasoning", { unavailable: "Encrypted or opaque reasoning cannot be tokenized locally." });
    } else if (event.type === "user.message") {
      add(record, "user", typeof data.content === "string" ? data.content : undefined, "User message", {
        attachments: Array.isArray(data.attachments) ? data.attachments.slice(0, 30).map((attachment) => ({
          type: str(attachment?.type) || "attachment", bytes: optional(attachment?.size), tokens: count(null),
        })) : [],
      });
    } else if (event.type === "tool.execution_start") {
      const name = str(data.toolName) || "Tool";
      calls.set(`${record.agent}:${data.toolCallId}`, name);
      add(record, "calls", jsonText(data.arguments), name, { tool: name });
    } else if (event.type === "tool.execution_complete") {
      const name = calls.get(`${record.agent}:${data.toolCallId}`) || "Tool result";
      // detailedContent can repeat or exceed what the model received; count content only.
      add(record, "results", typeof data.result?.content === "string" ? data.result.content : undefined, name, {
        tool: name, success: typeof data.success === "boolean" ? data.success : null,
      });
    } else if (event.type === "system.message" || event.type === "instruction.update") {
      add(record, "injected", typeof data.content === "string" ? data.content : undefined, event.type === "instruction.update" ? "Instruction update" : "System message");
    } else if (event.type === "skill.invoked" || event.type === "skill.invoked_ref") {
      if (typeof data.contentId === "string") skillReferences.add(`${record.agent}:${data.contentId}`);
      add(record, "skills", typeof data.content === "string" ? data.content : undefined, str(data.name) || "Skill invocation", {
        skill: str(data.name), unavailable: typeof data.content === "string" ? null : "Invocation recorded; the skill body is a content reference.",
      });
    } else if (event.type === "skill.context_delivered" || event.type === "skill.context_delivered_ref") {
      if (typeof data.contentId === "string" && skillReferences.has(`${record.agent}:${data.contentId}`)) return;
      if (typeof data.contentId === "string") skillReferences.add(`${record.agent}:${data.contentId}`);
      add(record, "skills", typeof data.content === "string" ? data.content : undefined, "Skill context", {
        unavailable: typeof data.content === "string" ? null : "Only a content reference was recorded; its body is not in this event.",
      });
    }
    if (event.type === "session.compaction_complete" && data.success === true) {
      state.epoch++;
      state.weights = {};
      if (typeof data.summary === "string") add(record, "injected", data.summary, "Compaction summary");
    }
    while (calls.size > limit * 5) calls.delete(calls.keys().next().value);
  }
  function usage(data, record) {
    const state = agentFor(record.agent);
    const request = ids(data).map((id) => state.requests.get(id)).find(Boolean);
    const point = {
      ...record, ids: ids(data), weights: request?.weights ?? { ...state.weights },
      boundary: request?.boundary ?? record.line, epoch: request?.epoch ?? state.epoch,
      userLine: request?.userLine ?? state.lastUser, matchedResponse: Boolean(request),
      input: optional(data.inputTokens), output: optional(data.outputTokens), cacheRead: optional(data.cacheReadTokens),
      duration: optional(data.duration), promptBudget: optional(data.maxPromptTokens), model: str(data.model) || "Unknown model",
    };
    if (bounded(receipts, point)) droppedRequests++;
  }
  function checkpoint(data, record) {
    for (const [lane, conversation] of (Array.isArray(data.promptCacheBreakState) ? data.promptCacheBreakState : []).slice(0, 20).entries()) {
      for (const [key, value] of Object.entries(object(conversation?.models)).slice(0, 20)) {
        if (!value || typeof value !== "object") continue;
        const requestIds = ids(value);
        const model = str(value.model ?? key);
        const identity = JSON.stringify([lane, key, requestIds, requestIds.length ? null : value.completed_at || record.line]);
        const system = Array.isArray(value.system_segments) ? value.system_segments.slice(0, 100).map((segment) => ({
          title: str(segment?.segment) || "System segment", tokens: count(segment?.tokens), category: "system", line: record.line,
        })) : [];
        const snapshot = {
          ...record, ids: requestIds, model, lane: lane + 1, prompt: optional(value.prompt_tokens), system,
          schemas: optional(value.tool_tokens), tools: Array.isArray(value.tools) ? value.tools.slice(0, 200).map((tool) => str(tool?.name) || "Unnamed tool") : [],
          timestamp: typeof value.completed_at === "string" && Number.isFinite(Date.parse(value.completed_at)) ? value.completed_at : record.timestamp,
        };
        snapshots.set(identity, snapshot);
        while (snapshots.size > limit) snapshots.delete(snapshots.keys().next().value);
      }
    }
  }
  function finish(durable) {
    const points = receipts.filter((point) => point.durable === durable);
    const byId = new Map();
    for (const snapshot of snapshots.values()) for (const id of snapshot.ids) {
      const list = byId.get(id) ?? [];
      list.push(snapshot); byId.set(id, list);
    }
    const matched = new Set();
    const history = points.map((point) => {
      // Some runtimes persist the usage receipt before its assistant message.
      const request = point.ids.map((id) => agents.get(point.agent)?.requests.get(id)).find(Boolean);
      const candidates = [...new Set(point.ids.flatMap((id) => byId.get(id) ?? []))];
      const snapshot = candidates.length === 1 ? candidates[0] : null;
      if (snapshot) matched.add(snapshot);
      const recorded = {};
      if (snapshot?.system.length && snapshot.system.every((part) => part.tokens.value !== null)) recorded.system = snapshot.system.reduce((sum, part) => sum + part.tokens.value, 0);
      if (snapshot?.schemas !== null && snapshot?.schemas !== undefined) recorded.schemas = snapshot.schemas;
      const total = snapshot?.prompt ?? point.input;
      const { ids: ignoredIds, weights, ...rest } = point;
      return { ...rest, boundary: request?.boundary ?? point.boundary, epoch: request?.epoch ?? point.epoch,
        responseLine: request?.responseLine ?? null, matchedResponse: Boolean(request),
        id: `request-${point.line}`, snapshotLine: snapshot?.line ?? null,
        system: snapshot?.system ?? [], schemas: snapshot?.tools ?? [],
        composition: composition(request?.weights ?? weights, recorded, total),
        observed: contentComposition(request?.weights ?? weights),
        source: snapshot ? "Matched prompt snapshot" : point.input !== null ? "Recorded request input" : "Observed text",
      };
    });
    // Unmatched snapshots remain useful observations, but receive no guessed agent or text attribution.
    for (const snapshot of snapshots.values()) {
      if (matched.has(snapshot)) continue;
      const recorded = {};
      if (snapshot.system.length && snapshot.system.every((part) => part.tokens.value !== null)) recorded.system = snapshot.system.reduce((sum, part) => sum + part.tokens.value, 0);
      if (snapshot.schemas !== null) recorded.schemas = snapshot.schemas;
      history.push({ id: `snapshot-${snapshot.line}-${snapshot.lane}-${history.length}`, line: snapshot.line, snapshotLine: snapshot.line,
        timestamp: snapshot.timestamp, boundary: null, epoch: null, turn: snapshot.turn, agent: `unmatched-lane-${snapshot.lane}`,
        model: snapshot.model, input: snapshot.prompt, output: null, cacheRead: null, duration: null, promptBudget: null,
        system: snapshot.system, schemas: snapshot.tools, composition: composition({}, recorded, snapshot.prompt), observed: contentComposition({}),
        source: "Unmatched prompt snapshot", userLine: null });
    }
    if (!history.length) {
      for (const [agent, state] of agents) {
        if (!state.itemCount) continue;
        history.push({ id: `observed-${agent}`, line: state.lastLine, boundary: state.lastLine, agent, epoch: state.epoch,
          turn: 0, model: "Unknown model", system: [], schemas: [], composition: composition(state.weights), observed: contentComposition(state.weights),
          source: "Observed text estimate", input: null, output: null, cacheRead: null, duration: null, userLine: state.lastUser });
      }
    }
    history.sort((a, b) => a.line - b.line);
    return { history: history.slice(-limit), items, droppedItems, droppedRequests,
      method: "Charts estimate recorded text, not the full provider prompt. Actual request input/output are shown separately. Missing system prompts, schema bodies and media are excluded, never carried forward.",
      categories: CATEGORIES };
  }
  return { visit, usage, checkpoint, finish };
}
