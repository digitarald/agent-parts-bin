import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createContextProjection } from "./context.mjs";
import { randomUUID } from "node:crypto";
import { dayFormatter, hourFormatter, shiftDay } from "./activity.mjs";
import { addMcp, serializeMcps, mcpIdentity, emptyRoles } from "./primitives.mjs";

export const LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, lineBytes: 4 * 1024 * 1024, events: 200_000, rows: 2_000, sessions: 100, overview: 20 });
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value, max = 120) => typeof value === "string" ? value.slice(0, max) : "";
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const tokenKeys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

export class SourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function defaultRoot() {
  const home = process.env.COPILOT_HOME;
  return join(typeof home === "string" && home.length ? home : homedir() + "/.copilot", "session-state");
}

export function validateId(id) {
  if (typeof id !== "string" || !idPattern.test(id) || id === "." || id === "..") {
    throw new SourceError("invalid_session", "Choose a session from the list.");
  }
  return id;
}

async function sourceRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new SourceError("invalid_root", "The session directory must be an absolute path.");
  try { return await realpath(root); }
  catch (error) {
    if (error.code === "ENOENT") throw new SourceError("source_missing", "Session directory not found. Open with a compatible sessionRoot.");
    throw new SourceError("source_unreadable", "Cannot read the session directory. Check its permissions.");
  }
}

async function sessionFile(root, id) {
  validateId(id);
  const directory = await sourceRoot(root);
  try {
    const candidate = join(directory, id, "events.jsonl");
    const info = await lstat(candidate);
    const resolved = await realpath(candidate);
    const within = relative(directory, resolved);
    if (info.isSymbolicLink() || !info.isFile() || within.startsWith(".." + sep) || isAbsolute(within) || within !== join(id, "events.jsonl")) {
      throw new SourceError("unsafe_source", "Session files must be regular files inside the selected directory.");
    }
    return { path: resolved, info };
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (error.code === "ENOENT") throw new SourceError("session_missing", "Session file no longer exists. Refresh the session list.");
    throw new SourceError("source_unreadable", "Cannot read this session. Check its permissions.");
  }
}

export async function listSessions(root, limit = LIMITS.sessions) {
  const directory = await sourceRoot(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const sessions = [];
  let unreadable = 0;
  let withoutLogs = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    try {
      const { info } = await sessionFile(directory, entry.name);
      sessions.push({ id: entry.name, updatedAt: info.mtime.toISOString(), bytes: info.size });
    } catch (error) {
      if (error instanceof SourceError && error.code === "session_missing") withoutLogs++;
      else if (error instanceof SourceError) unreadable++;
      else throw error;
    }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { sessions: sessions.slice(0, limit), total: sessions.length, unreadable, withoutLogs, limit };
}

// Read a fixed byte snapshot. A concurrent append is picked up on the next refresh.
async function scan(path, size, visit) {
  const coverage = { malformed: 0, duplicates: 0, missingIds: 0, partialTail: false, oversizedLines: 0, capped: size > LIMITS.bytes, lines: 0 };
  if (!size) return coverage;
  const stream = createReadStream(path, { start: 0, end: Math.min(size, LIMITS.bytes) - 1, highWaterMark: 64 * 1024 });
  let pending = Buffer.alloc(0);
  let dropping = false;
  const consume = (line) => {
    coverage.lines++;
    if (coverage.lines > LIMITS.events) { coverage.capped = true; return; }
    if (!line.length || !line.toString("utf8").trim()) return;
    let event;
    try { event = JSON.parse(line.toString("utf8")); }
    catch { coverage.malformed++; return; }
    if (!event || typeof event !== "object" || typeof event.type !== "string" || !event.data || typeof event.data !== "object") {
      coverage.malformed++; return;
    }
    visit(event, coverage.lines, line.length, coverage);
  };
  try {
    for await (const chunk of stream) {
      let offset = 0;
      while (offset < chunk.length) {
        const end = chunk.indexOf(10, offset);
        const fragment = chunk.subarray(offset, end < 0 ? chunk.length : end);
        if (!dropping && pending.length + fragment.length > LIMITS.lineBytes) { dropping = true; coverage.oversizedLines++; pending = Buffer.alloc(0); }
        if (!dropping) pending = Buffer.concat([pending, fragment]);
        if (end < 0) break;
        if (!dropping) consume(pending);
        else coverage.lines++;
        pending = Buffer.alloc(0);
        dropping = false;
        offset = end + 1;
      }
      if (coverage.lines > LIMITS.events) break;
    }
    if (pending.length || dropping) coverage.partialTail = true;
  } catch {
    throw new SourceError("read_failed", "Session changed or could not be read. Refresh and try again.");
  }
  return coverage;
}

function category(type) {
  if (type.startsWith("tool.") || type.startsWith("external_tool.")) return "tools";
  if (type.startsWith("subagent.")) return "agents";
  if (type.startsWith("skill.")) return "skills";
  if (type.startsWith("instruction.") || type === "system.message") return "instructions";
  if (type.startsWith("user.")) return "user";
  if (type.startsWith("assistant.message")) return "assistant";
  if (type.includes("usage")) return "usage";
  if (type.includes("compaction") || type.includes("model_change") || type.includes("prun")) return "context";
  return "other";
}

function newUsage() {
  return { records: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, missing: Object.fromEntries(tokenKeys.map((key) => [key, 0])) };
}
function addUsage(total, data) {
  total.records++;
  for (const key of tokenKeys) {
    const value = number(data[key]);
    if (value === null) total.missing[key]++;
    else total[key] += value;
  }
}
function finishUsage(value) {
  for (const key of tokenKeys) if (!value.records || value.missing[key] === value.records) value[key] = null;
  const complete = tokenKeys.every((key) => value.missing[key] === 0 && value[key] !== null);
  value.uncachedInput = complete ? value.inputTokens - value.cacheReadTokens - value.cacheWriteTokens : null;
  value.conflicted = value.uncachedInput !== null && value.uncachedInput < 0;
  if (value.conflicted) value.uncachedInput = null;
  return value;
}

function fileOperations(name, args) {
  if (!args || typeof args !== "object") return [];
  const short = name.split(/[./]/).at(-1);
  let kind;
  if (["view", "read_file", "read", "readFile"].includes(short)) kind = "read";
  if (["rg", "glob", "grep", "search", "list_dir"].includes(short)) kind = "search";
  if (["write_file", "create_file", "create", "write"].includes(short)) kind = "write";
  if (["edit", "replace_string_in_file", "apply_patch", "edit_file"].includes(short)) kind = "edit";
  const paths = [args.path, args.filePath, args.file_path, args.filename, ...(Array.isArray(args.paths) ? args.paths : typeof args.paths === "string" ? [args.paths] : [])]
    .filter((path) => typeof path === "string" && path.length && !path.includes("\0")).slice(0, 100);
  if (short === "apply_patch" && typeof args.input === "string") {
    for (const match of args.input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1]);
  }
  return kind ? [...new Set(paths)].slice(0, 100).map((path) => ({ path: text(path, 500), kind })) : [];
}

function commandInfo(name, args) {
  if (!/(^|[._/])(bash|shell|execute|run_in_terminal|exec_command)$/.test(name) || !args || typeof args !== "object") return null;
  const command = args.command ?? args.cmd;
  if (typeof command !== "string") return null;
  return { program: text(command.trim().match(/^[^\s;&|]+/)?.[0] ?? "shell", 80), background: args.mode === "async" || args.isBackground === true };
}

export function createFold(id, { summaryOnly = false, timeZone = "UTC" } = {}) {
  const dayFor = dayFormatter(timeZone);
  const hourFor = hourFormatter(timeZone);
  const seen = new Set();
  const receipts = new Set();
  const projection = summaryOnly ? null : createContextProjection(LIMITS.rows);
  const tools = new Map();
  const toolIds = new Set();
  const starts = new Set();
  const completions = new Set();
  const toolOwners = new Map();
  const toolCounts = new Map();
  const turns = new Map();
  let failedTools = 0;
  const agents = new Map();
  const childAgents = new Set();
  const skills = new Map();
  const mcpServers = new Map();
  const otherTools = new Map();
  const agentPrimitives = new Map();
  const primitiveEvents = [];
  const types = new Map();
  const receiptUsage = newUsage();
  const liveUsage = newUsage();
  const daily = new Map();
  const modelUsage = new Map();
  const rows = [];
  const usageRows = [];
  const files = [];
  const markers = [];
  let turn = 0;
  let first = null;
  let last = null;
  let context = null;
  let cacheSnapshots = [];
  let accounting = null;
  let totalEvents = 0;
  let assistantMessages = 0;
  let model = "";
  let title = "", workspace = "";
  let identitySeen = false;
  let mismatchedIdentity = false;
  let cappedDetails = false;
  let undated = 0;
  const activityBucket = (time) => ({
    events: 0, tools: 0, turns: 0, failed: 0, skills: 0, firstEventAt: time, lastEventAt: time,
    receipts: newUsage(), live: newUsage(), toolRanking: new Map(), skillRanking: new Map(), models: new Map(), mcps: new Map(),
  });
  const retain = (list, value) => {
    if (summaryOnly) return;
    list.push(value);
    if (list.length > LIMITS.rows) { list.shift(); cappedDetails = true; }
  };
  function visit(event, line, bytes, coverage) {
    if (typeof event.id === "string") {
      if (seen.has(event.id)) { coverage.duplicates++; return; }
      seen.add(event.id);
    } else coverage.missingIds++;
    const data = event.data;
    const time = timestamp(event.timestamp);
    const agent = text(event.agentId || "main");
    if (typeof event.agentId === "string" && event.agentId && (["subagent.started", "subagent.completed"].includes(event.type) || data.parentToolCallId || data.usage?.parentToolCallId)) childAgents.add(agent);
    totalEvents++;
    if (time) { if (!first || time < first) first = time; if (!last || time > last) last = time; }
    types.set(event.type, (types.get(event.type) ?? 0) + 1);
    if (event.type === "session.start") {
      identitySeen = true;
      if (data.sessionId !== id) mismatchedIdentity = true;
      model = text(data.selectedModel ?? data.model);
      title = text(data.title);
      const cwd = text(data.context?.cwd, 1000);
      workspace = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    }
    if (event.type === "session.title_changed" && typeof data.title === "string") title = text(data.title);
    if (event.type === "session.model_change") model = text(data.newModel ?? data.model) || model;
    if (event.type === "user.message") { turn++; turns.set(agent, (turns.get(agent) ?? 0) + 1); }
    if (event.type === "assistant.message") assistantMessages++;
    const record = { line, type: text(event.type), timestamp: time, agent, turn: turns.get(agent) ?? 0, category: category(event.type), bytes };
    if (!agentPrimitives.has(agent)) agentPrimitives.set(agent, { skills: new Map(), mcps: new Map(), tools: new Map(), models: new Map() });
    const primitives = agentPrimitives.get(agent);
    retain(rows, record);
    projection?.visit(event, record);
    if (!agents.has(agent)) agents.set(agent, { id: agent, events: 0, tools: 0, parent: null });
    agents.get(agent).events++;
    const day = time ? dayFor(time) : null;
    if (!day) undated++;
    if (day && !daily.has(day)) daily.set(day, { day, ...activityBucket(time), hours: new Map() });
    const dailyBucket = day ? daily.get(day) : null;
    const buckets = [];
    if (dailyBucket) {
      const hour = hourFor(time);
      if (!dailyBucket.hours.has(hour.key)) dailyBucket.hours.set(hour.key, { ...hour, ...activityBucket(time) });
      buckets.push(dailyBucket, dailyBucket.hours.get(hour.key));
    }
    for (const bucket of buckets) {
      bucket.events++;
      if (time < bucket.firstEventAt) bucket.firstEventAt = time;
      if (time > bucket.lastEventAt) bucket.lastEventAt = time;
      if (event.type === "user.message") bucket.turns++;
    }
    if (event.type === "session.usage_record" || event.type === "assistant.usage") {
      const durable = event.type === "session.usage_record";
      const usage = durable ? data.usage : data;
      if (usage && typeof usage === "object") {
        const identity = typeof usage.accounting?.usageId === "string"
          ? JSON.stringify([durable, usage.accounting.sourceSessionId, usage.accounting.usageId]) : null;
        if (identity && receipts.has(identity)) { coverage.duplicates++; return; }
        if (identity) receipts.add(identity);
        projection?.usage(usage, { ...record, durable });
        addUsage(durable ? receiptUsage : liveUsage, usage);
        for (const bucket of buckets) addUsage(durable ? bucket.receipts : bucket.live, usage);
        const usageModel = text(usage.model ?? data.model) || "Unattributed";
        const usageOwner = !event.agentId && usage.parentToolCallId ? `delegated:${text(usage.parentToolCallId)}` : agent;
        if (usage.parentToolCallId) childAgents.add(usageOwner);
        const key = `${durable}:${usageModel}`;
        if (!modelUsage.has(key)) modelUsage.set(key, { durable, model: usageModel, owners: new Map(), ...newUsage() });
        addUsage(modelUsage.get(key), usage);
        modelUsage.get(key).owners.set(usageOwner, (modelUsage.get(key).owners.get(usageOwner) ?? 0) + 1);
        if (!primitives.models.has(key)) primitives.models.set(key, { durable, name: usageModel, count: 0, owners: new Map() });
        primitives.models.get(key).count++;
        primitives.models.get(key).owners.set(usageOwner, (primitives.models.get(key).owners.get(usageOwner) ?? 0) + 1);
        for (const bucket of buckets) {
          if (!bucket.models.has(key)) bucket.models.set(key, { durable, name: usageModel, owners: new Map(), ...newUsage() });
          addUsage(bucket.models.get(key), usage);
          bucket.models.get(key).owners.set(usageOwner, (bucket.models.get(key).owners.get(usageOwner) ?? 0) + 1);
        }
        retain(primitiveEvents, { ...record, kind: "models", name: usageModel, durable, delegated: Boolean(usage.parentToolCallId) });
        retain(usageRows, { ...record, durable, model: usageModel, ...Object.fromEntries(tokenKeys.map((key) => [key, number(usage[key])])),
          duration: number(usage.duration ?? data.duration), promptBudget: number(usage.maxPromptTokens),
          ttft: number(usage.timeToFirstTokenMs), reasoningTokens: number(usage.reasoningTokens) });
      }
    }
    if (!summaryOnly && (event.type === "session.usage_checkpoint" || event.type === "session.shutdown")) {
      projection.checkpoint(data, record);
      const snapshot = data.accountingSnapshot ?? data;
      accounting = { line, timestamp: time, status: text(snapshot.aiCreditsStatus) || "unknown",
        nanoAiu: number(snapshot.totalNanoAiu), apiDuration: number(snapshot.totalApiDurationMs) };
      if (Array.isArray(data.promptCacheBreakState)) {
        cacheSnapshots = data.promptCacheBreakState.slice(0, 20).flatMap((conversation, lane) =>
          Object.entries(conversation.models ?? {}).slice(0, 20).map(([name, value]) => ({
            lane: lane + 1, model: text(name), line, timestamp: time,
            promptTokens: number(value.prompt_tokens), frontierTokens: number(value.frontier_tokens), toolTokens: number(value.tool_tokens),
            toolCount: number(value.tool_count), messageCount: number(value.conversation?.message_count),
            systemSegments: Array.isArray(value.system_segments) ? value.system_segments.slice(0, 100).map((segment) => ({ name: text(segment.segment), tokens: number(segment.tokens) })) : [],
          })));
      }
    }
    if (["session.usage_info", "session.shutdown"].includes(event.type) && number(data.currentTokens) !== null) {
      context = {
        source: event.type, line, timestamp: time, currentTokens: number(data.currentTokens),
        tokenLimit: number(data.tokenLimit), systemTokens: number(data.systemTokens),
        conversationTokens: number(data.conversationTokens), toolDefinitionsTokens: number(data.toolDefinitionsTokens),
      };
    }
    if (["context", "instructions", "skills"].includes(record.category)) retain(markers, { ...record, success: typeof data.success === "boolean" ? data.success : null, tokensRemoved: number(data.tokensRemoved) });
    if (["skill.invoked", "skill.invoked_ref"].includes(event.type)) {
      const name = text(data.name ?? data.skillName ?? data.skill) || "Unnamed skill";
      skills.set(name, (skills.get(name) ?? 0) + 1);
      primitives.skills.set(name, (primitives.skills.get(name) ?? 0) + 1);
      retain(primitiveEvents, { ...record, kind: "skills", name, plugin: text(data.pluginName) });
      for (const bucket of buckets) { bucket.skills++; bucket.skillRanking.set(name, (bucket.skillRanking.get(name) ?? 0) + 1); }
    }
    if (event.type === "tool.execution_start") {
      const callId = text(data.toolCallId, 200);
      const key = `${agent}:${callId}`;
      if (!callId || starts.has(key)) return;
      starts.add(key); toolIds.add(key); toolOwners.set(callId, agent);
      const name = text(data.toolName) || "unknown";
      const args = typeof data.arguments === "object" ? data.arguments : { input: data.arguments };
      agents.get(agent).tools++;
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      const mcp = mcpIdentity(data);
      if (mcp) { addMcp(mcpServers, mcp); addMcp(primitives.mcps, mcp); }
      else {
        otherTools.set(name, (otherTools.get(name) ?? 0) + 1);
        primitives.tools.set(name, (primitives.tools.get(name) ?? 0) + 1);
      }
      retain(primitiveEvents, { ...record, kind: mcp ? "mcps" : "tools", name: mcp?.name ?? name, tool: mcp?.tool, callId });
      for (const bucket of buckets) {
        bucket.tools++;
        if (mcp) addMcp(bucket.mcps, mcp);
        else bucket.toolRanking.set(name, (bucket.toolRanking.get(name) ?? 0) + 1);
      }
      if (summaryOnly) return;
      if (tools.size >= LIMITS.rows * 5) { cappedDetails = true; return; }
      tools.set(key, { ...record, callId, name, startedAt: time, completedAt: null, success: null, duration: null, command: commandInfo(name, args) });
      for (const op of fileOperations(name, args)) retain(files, { ...op, line, timestamp: time, key });
    }
    if (event.type === "tool.execution_complete") {
      const callId = text(data.toolCallId, 200);
      const key = `${agent}:${callId}`;
      if (!callId || completions.has(key)) return;
      completions.add(key); toolIds.add(key);
      if (data.success === false) failedTools++;
      if (data.success === false) for (const bucket of buckets) bucket.failed++;
      if (summaryOnly) return;
      if (tools.size >= LIMITS.rows * 5 && !tools.has(key)) return;
      const tool = tools.get(key) ?? { ...record, callId, name: "unpaired completion", startedAt: null, command: null };
      tool.completedAt = time;
      tool.success = typeof data.success === "boolean" ? data.success : null;
      tool.completeLine = line;
      const elapsed = time && tool.startedAt ? Date.parse(time) - Date.parse(tool.startedAt) : -1;
      tool.duration = elapsed >= 0 ? elapsed : null;
      tools.set(key, tool);
    }
    if (event.type.startsWith("subagent.") && typeof event.agentId === "string") {
      const childId = agent;
      const child = agents.get(childId) ?? { id: childId, events: 0, tools: 0 };
      const parent = toolOwners.get(data.toolCallId);
      if (parent && parent !== childId) child.parent = parent;
      child.model = text(data.model) || child.model;
      child.name = text(data.agentDisplayName ?? data.agentName) || child.name;
      child.lastEvent = event.type;
      child.line = line;
      if (event.type === "subagent.completed") {
        child.summaryTokens = number(data.totalTokens);
        child.summaryTools = number(data.totalToolCalls);
        child.duration = number(data.durationMs);
      }
      agents.set(childId, child);
    }
  }
  function finish(coverage) {
    const durable = receiptUsage.records > 0;
    const calls = [...tools.values()];
    const usage = finishUsage(durable ? receiptUsage : liveUsage);
    usage.source = durable ? "durable receipts" : liveUsage.records ? "captured live events" : "not recorded";
    usage.partial = !durable || tokenKeys.some((key) => usage.missing[key] > 0);
    const warnings = [];
    if (coverage.capped) warnings.push("Read limit reached. Counts cover only the scanned prefix.");
    if (coverage.partialTail) warnings.push("An unfinished final line is waiting for the next refresh.");
    if (coverage.malformed) warnings.push(`${coverage.malformed} malformed records skipped.`);
    if (coverage.oversizedLines) warnings.push(`${coverage.oversizedLines} oversized records skipped.`);
    if (coverage.missingIds) warnings.push(`${coverage.missingIds} records have no ID and cannot be deduplicated.`);
    if (!identitySeen) warnings.push("Session identity was not recorded in this file.");
    if (mismatchedIdentity) throw new SourceError("identity_mismatch", "The log identity does not match the selected session.");
    if (cappedDetails) warnings.push(`Detail lists retain ${LIMITS.rows} rows and up to ${LIMITS.rows * 5} correlated tools; aggregate counts cover the scanned events.`);
    if (coverage.rotated) warnings.push("Rotated segments exist. This prototype reads events.jsonl only; history and receipt totals are partial.");
    if (usage.conflicted) warnings.push("Cache counts exceed input tokens. Uncached input is unavailable.");
    if (undated) warnings.push(`${undated} events have no valid timestamp and are excluded from date-range totals.`);
    const roleFor = (agent) => childAgents.has(agent) ? "subagent" : agent === "main" ? "main" : "unknown";
    const rolesFor = (owners) => {
      const roles = emptyRoles();
      for (const [agent, count] of owners) roles[roleFor(agent)] += count;
      return roles;
    };
    const ranks = (map) => [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    function serializeBucket(bucket) {
      const { events, tools, turns, skills, failed, firstEventAt, lastEventAt, receipts, live, toolRanking, skillRanking, models, mcps } = bucket;
      return {
        events, tools, turns, skills, failed, firstEventAt, lastEventAt, usage: finishUsage(durable ? receipts : live),
        rankings: {
          tools: [...toolRanking].map(([name, count]) => ({ name, count })),
          skills: [...skillRanking].map(([name, count]) => ({ name, count })),
          mcps: serializeMcps(mcps),
          models: [...models.values()].filter((item) => item.durable === durable).map((item) => {
            const usage = finishUsage(item);
            return { name: item.name, count: usage.records, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, roles: rolesFor(item.owners) };
          }),
        },
      };
    }
    const result = {
      format: "session-lens.v1", id, title, workspace, firstEventAt: first, lastEventAt: last, model,
      coverage: { ...coverage, undated, retainedRows: rows.length, warnings, complete: !coverage.capped && !coverage.malformed && !coverage.oversizedLines && !coverage.rotated && !undated && identitySeen },
      counts: { events: totalEvents, turns: turn, assistantMessages, tools: toolIds.size, completed: completions.size,
        failed: failedTools, incomplete: toolIds.size - completions.size, skills: [...skills.values()].reduce((a, b) => a + b, 0) },
      contextView: projection?.finish(durable),
      usage, context, cacheSnapshots, accounting, models: [...modelUsage.values()].filter((item) => item.durable === durable).map((item) => {
        const { owners, ...value } = finishUsage(item); return { ...value, roles: rolesFor(owners) };
      }),
      primitives: {
        skills: ranks(skills), mcps: serializeMcps(mcpServers), tools: ranks(otherTools),
        models: [...modelUsage.values()].filter((item) => item.durable === durable).map((item) => ({ name: item.model, count: item.records, roles: rolesFor(item.owners) })),
        agents: Object.fromEntries([...agentPrimitives].map(([agent, values]) => [agent, {
          skills: ranks(values.skills), mcps: serializeMcps(values.mcps), tools: ranks(values.tools),
          models: [...values.models.values()].filter((item) => item.durable === durable).map(({ name, count, owners }) => ({ name, count, roles: rolesFor(owners) })),
        }])),
        events: primitiveEvents.filter((entry) => entry.kind !== "models" || entry.durable === durable).map((entry) => ({ ...entry, role: entry.delegated ? "subagent" : roleFor(entry.agent) })),
      },
      timeline: usageRows.filter((item) => item.durable === durable), events: rows, tools: calls,
      files: files.map(({ key, ...op }) => ({ ...op, success: tools.get(key)?.success ?? null })),
      agents: [...agents.values()], markers, skills: [...skills].map(([name, count]) => ({ name, count })),
      toolRanking: [...toolCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      types: [...types].map(([name, count]) => ({ name, count })),
      daily: [...daily.values()].map((bucket) => ({
        day: bucket.day, ...serializeBucket(bucket),
        hours: [...bucket.hours.values()].map((hour) => ({ key: hour.key, hour: hour.hour, label: hour.label, ...serializeBucket(hour) })),
      })),
    };
    return summaryOnly ? { id, title, workspace, daily: result.daily, coverage: result.coverage } : result;
  }
  return { visit, finish };
}

export async function readSession(root, id, options) {
  const { path, info } = await sessionFile(root, id);
  const fold = createFold(id, options);
  const coverage = await scan(path, info.size, fold.visit);
  const siblings = await readdir(join(path, ".."));
  coverage.rotated = siblings.some((name) => /^events\.\d+\.jsonl$/.test(name));
  const result = fold.finish(coverage);
  result.fileModifiedAt = info.mtime.toISOString();
  result.fileBytes = info.size;
  result.readAt = new Date().toISOString();
  return result;
}

export async function readDetail(root, id, line) {
  if (!Number.isSafeInteger(line) || line < 1 || line > LIMITS.events) throw new SourceError("invalid_line", "Choose a recorded event.");
  const { path, info } = await sessionFile(root, id);
  let result;
  await scan(path, info.size, (event, at) => {
    if (at !== line) return;
    const serialized = JSON.stringify(event.data, null, 2);
    result = { line, type: text(event.type), content: serialized.slice(0, 24_000), truncated: serialized.length > 24_000 };
  });
  if (!result) throw new SourceError("event_missing", "This event is no longer available. Refresh the session.");
  return result;
}

export function publicSummary(snapshot) {
  const { id, firstEventAt, lastEventAt, counts, usage, context, coverage, fileBytes, readAt } = snapshot;
  return { id, firstEventAt, lastEventAt, counts, usage, context, coverage, fileBytes, readAt };
}

export function createStore(root) {
  const cache = new Map();
  const summaries = new Map();
  const scans = new Map();
  return {
    list: () => listSessions(root),
    async read(id, refresh = false) {
      const { info } = await sessionFile(root, id);
      const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      const cached = cache.get(id);
      if (!refresh && cached?.key === key) return cached.value;
      const value = await readSession(root, id);
      cache.set(id, { key, value });
      if (cache.size > LIMITS.overview) cache.delete(cache.keys().next().value);
      return value;
    },
    detail: (id, line) => readDetail(root, id, line),
    async overview({ timeZone = "UTC", scanId, offset = 0, historyDays = 30 } = {}) {
      try { dayFormatter(timeZone); }
      catch { throw new SourceError("invalid_timezone", "Choose a valid time zone."); }
      if (!Number.isSafeInteger(offset) || offset < 0) throw new SourceError("invalid_offset", "Restart the activity scan.");
      if (![0, 30].includes(historyDays)) throw new SourceError("invalid_history_limit", "History limit must be 30 days or all history.");
      let scan = scans.get(scanId);
      if (scanId && !scan) throw new SourceError("scan_expired", "This scan has expired. Refresh activity to start again.");
      if (!scan) {
        if (offset !== 0) throw new SourceError("invalid_offset", "Start scanning at the first batch.");
        const listing = await listSessions(root, Infinity);
        const dayFor = dayFormatter(timeZone);
        const cutoff = historyDays ? shiftDay(dayFor(new Date()), -(historyDays - 1)) : null;
        const eligible = cutoff ? listing.sessions.filter((item) => dayFor(item.updatedAt) >= cutoff) : listing.sessions;
        scanId = randomUUID();
        scan = { ...listing, sessions: eligible, total: eligible.length, excluded: listing.sessions.length - eligible.length, cutoff, historyDays, timeZone, startedAt: new Date().toISOString() };
        scans.set(scanId, scan);
        if (scans.size > 2) scans.delete(scans.keys().next().value);
      }
      if (timeZone !== scan.timeZone || historyDays !== scan.historyDays || offset > scan.total) throw new SourceError("invalid_scan", "Restart the activity scan for these settings.");
      const sessions = [];
      const failures = [];
      let nextOffset = offset, bytes = 0;
      for (const item of scan.sessions.slice(offset, offset + LIMITS.overview)) {
        try {
          const { info } = await sessionFile(root, item.id);
          const key = `${timeZone}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
          const previous = summaries.get(item.id);
          const value = previous?.key === key ? previous.value : await readSession(root, item.id, { summaryOnly: true, timeZone });
          summaries.set(item.id, { key, value });
          if (summaries.size > 1000) summaries.delete(summaries.keys().next().value);
          sessions.push(scan.cutoff ? { ...value, daily: value.daily.filter((day) => day.day >= scan.cutoff) } : value);
          if (previous?.key !== key) bytes += Math.min(info.size, LIMITS.bytes);
        } catch (error) {
          if (!(error instanceof SourceError)) throw error;
          failures.push({ id: item.id, error: error.message });
        }
        nextOffset++;
        if (bytes >= 32 * 1024 * 1024) break;
      }
      return {
        sessions, failures, available: scan.total, scanned: nextOffset, limit: LIMITS.overview,
        scanId, nextOffset: nextOffset < scan.total ? nextOffset : null, timeZone,
        unreadable: scan.unreadable, startedAt: scan.startedAt, readAt: new Date().toISOString(),
        cutoff: scan.cutoff, excluded: scan.excluded,
      };
    },
  };
}
