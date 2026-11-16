import { emptyRoles, mergeMcps } from "./primitives.mjs";

export const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
const COUNTS = ["events", "turns", "tools", "failed", "skills"];

export function dayFormatter(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (timestamp) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

export function hourFormatter(timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, hour: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset",
  });
  return (timestamp) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
    return { key: `${parts.hour}@${parts.timeZoneName}`, hour: parts.hour, label: `${parts.hour}:00 ${parts.timeZoneName}` };
  };
}

// Find real local-day boundaries, including 23/25-hour days and skipped midnights.
export function dayStart(day, timeZone) {
  const dayFor = dayFormatter(timeZone), noon = Date.parse(`${day}T12:00:00Z`);
  let low = noon - 36 * 3600000, high = noon + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dayFor(middle) < day) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function validDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}

export function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function resolveRange(selection, timeZone, now = new Date()) {
  const today = dayFormatter(timeZone)(now);
  switch (selection.preset) {
    case "today": return { from: today, to: today };
    case "yesterday": return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case "7": return { from: shiftDay(today, -6), to: today };
    case "30": return { from: shiftDay(today, -29), to: today };
    case "all": return { from: null, to: today };
    case "custom":
      if (!validDay(selection.from) || !validDay(selection.to)) throw new Error("Choose a valid start and end date.");
      if (selection.from > selection.to) throw new Error("The start date must be on or before the end date.");
      return { from: selection.from, to: selection.to };
    default: throw new Error("Choose a date range.");
  }
}

export function emptyActivity() {
  return {
    events: 0, turns: 0, tools: 0, failed: 0, skills: 0, firstEventAt: null, lastEventAt: null,
    usage: { records: 0, ...Object.fromEntries(USAGE_KEYS.map((key) => [key, null])), missing: Object.fromEntries(USAGE_KEYS.map((key) => [key, 0])) },
    rankings: { tools: [], skills: [], models: [], mcps: [] },
  };
}

function mergeRankings(target, source) {
  for (const key of ["tools", "skills", "models"]) {
    const entries = new Map(target[key].map((item) => [item.name, { ...item }]));
    for (const item of source[key] ?? []) {
      const previous = entries.get(item.name) ?? { name: item.name, count: 0, inputTokens: null, outputTokens: null, ...(key === "models" ? { roles: emptyRoles() } : {}) };
      previous.count += item.count;
      if (key === "models") {
        previous.roles = { ...(previous.roles ?? emptyRoles()) };
        if (item.roles) for (const role of Object.keys(emptyRoles())) previous.roles[role] += item.roles[role] ?? 0;
        else previous.roles.unknown += item.count;
      }
      for (const field of ["inputTokens", "outputTokens"]) {
        if (item[field] !== null && item[field] !== undefined) previous[field] = (previous[field] ?? 0) + item[field];
      }
      entries.set(item.name, previous);
    }
    target[key] = [...entries.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  target.mcps = mergeMcps(target.mcps ?? [], source.mcps ?? []);
}

export function mergeActivity(target, source) {
  for (const key of COUNTS) target[key] += source[key] ?? 0;
  target.usage.records += source.usage.records;
  for (const key of USAGE_KEYS) {
    if (source.usage[key] !== null) target.usage[key] = (target.usage[key] ?? 0) + source.usage[key];
    target.usage.missing[key] += source.usage.missing[key] ?? 0;
  }
  if (source.firstEventAt && (!target.firstEventAt || source.firstEventAt < target.firstEventAt)) target.firstEventAt = source.firstEventAt;
  if (source.lastEventAt && (!target.lastEventAt || source.lastEventAt > target.lastEventAt)) target.lastEventAt = source.lastEventAt;
  mergeRankings(target.rankings, source.rankings);
}

export function summarizeActivity(sessions, range, day = null, hour = null) {
  const within = (value) => (!range.from || value >= range.from) && value <= range.to && (!day || value === day);
  const total = emptyActivity(), days = new Map(), rows = [];
  let partialSessions = 0;
  for (const session of sessions) {
    const selected = session.daily.filter((entry) => within(entry.day))
      .flatMap((entry) => hour ? (entry.hours ?? []).filter((item) => item.key === hour).map((item) => ({ ...item, day: entry.day })) : [entry]);
    if (!selected.length) continue;
    const activity = emptyActivity();
    for (const entry of selected) {
      mergeActivity(activity, entry);
      const bucket = days.get(entry.day) ?? { day: entry.day, ...emptyActivity() };
      mergeActivity(bucket, entry); days.set(entry.day, bucket);
    }
    mergeActivity(total, activity);
    if (!session.coverage.complete) partialSessions++;
    rows.push({ id: session.id, title: session.title, workspace: session.workspace, ...activity, coverage: session.coverage });
  }
  return { total, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), sessions: rows, partialSessions };
}

export function rangeDays(range, recordedDays, maximum = 90) {
  const from = range.from ?? recordedDays[0]?.day ?? range.to;
  const count = Math.round((Date.parse(`${range.to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000) + 1;
  const unit = count <= 45 ? "day" : count <= 365 ? "week" : "month";
  const monthCount = (Number(range.to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(range.to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  const months = monthCount > maximum ? 12 : 1;
  const buckets = [];
  for (let cursor = from; cursor <= range.to;) {
    let next;
    if (unit === "day") next = shiftDay(cursor, 1);
    else if (unit === "week") {
      const weekday = new Date(`${cursor}T12:00:00Z`).getUTCDay();
      next = shiftDay(cursor, 7 - (weekday + 6) % 7);
    } else {
      const date = new Date(`${cursor.slice(0, 7)}-01T12:00:00Z`);
      if (months === 12) date.setUTCMonth(0);
      date.setUTCMonth(date.getUTCMonth() + months);
      next = date.toISOString().slice(0, 10);
    }
    buckets.push({ from: cursor, to: next > range.to ? range.to : shiftDay(next, -1), unit: months === 12 && unit === "month" ? "year" : unit, ...emptyActivity() });
    cursor = next;
  }
  for (const day of recordedDays) {
    const bucket = buckets.find((bucket) => bucket.from <= day.day && bucket.to >= day.day);
    if (bucket) mergeActivity(bucket, day);
  }
  return buckets;
}

const hourLayouts = new Map();
export function rangeHours(day, sessions, timeZone, now = new Date()) {
  const layoutKey = `${timeZone}:${day}`;
  if (!hourLayouts.has(layoutKey)) {
    const format = hourFormatter(timeZone), start = dayStart(day, timeZone), end = dayStart(shiftDay(day, 1), timeZone);
    const slots = [];
    // Minute boundaries also cover modern half-hour DST transitions.
    for (let time = start; time < end; time += 60000) {
      const hour = format(time);
      if (slots.at(-1)?.key !== hour.key) {
        if (slots.length) slots.at(-1).end = time;
        slots.push({ ...hour, start: time, end });
      }
    }
    hourLayouts.set(layoutKey, slots);
    if (hourLayouts.size > 64) hourLayouts.delete(hourLayouts.keys().next().value);
  }
  const buckets = hourLayouts.get(layoutKey).map((slot) => ({ ...slot, from: day, to: day, unit: "hour", future: slot.start > Number(now), ...emptyActivity() }));
  for (const session of sessions) for (const entry of session.daily.filter((entry) => entry.day === day)) {
    for (const hour of entry.hours ?? []) {
      const bucket = buckets.find((bucket) => bucket.key === hour.key);
      if (bucket) mergeActivity(bucket, hour);
    }
  }
  return buckets;
}

export function focusMatcher(focus) {
  const dayFor = dayFormatter(focus.timeZone), hourFor = focus.hour ? hourFormatter(focus.timeZone) : null;
  return (timestamp) => {
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return false;
    const day = dayFor(timestamp);
    return (!focus.from || day >= focus.from) && day <= focus.to && (!hourFor || hourFor(timestamp).key === focus.hour);
  };
}

export function sessionFocus(history, focus) {
  const matches = focusMatcher(focus), matching = history.filter((point) => matches(point.timestamp) && point.observed?.chartTotal > 0);
  const point = matching.find((point) => point.agent === "main") ?? matching[0];
  if (!point) return null;
  const lane = history.filter((candidate) => candidate.agent === point.agent && candidate.observed?.chartTotal > 0);
  return { agent: point.agent, pinned: point.id, end: Math.min(lane.length, Math.max(48, lane.indexOf(point) + 24)) };
}
