const text = (value) => typeof value === "string" ? value.slice(0, 160) : "";
export const ROLE_LABELS = { main: "Main", subagent: "Subagent", unknown: "Unattributed" };
export const emptyRoles = () => ({ main: 0, subagent: 0, unknown: 0 });

export function mcpIdentity(data) {
  const name = text(data.mcpConfigServerName) || text(data.mcpServerName);
  if (!name) return null;
  return { name, displayName: text(data.mcpServerDisplayName) || name, tool: text(data.mcpToolName) || text(data.toolName) || "Unnamed tool" };
}

export function addMcp(map, identity, amount = 1) {
  const entry = map.get(identity.name) ?? { name: identity.name, displayName: identity.displayName, count: 0, tools: new Map() };
  entry.count += amount;
  if (identity.displayName !== identity.name) entry.displayName = identity.displayName;
  entry.tools.set(identity.tool, (entry.tools.get(identity.tool) ?? 0) + amount);
  map.set(identity.name, entry);
}

export function serializeMcps(map) {
  return [...map.values()].map((entry) => ({ ...entry, tools: [...entry.tools].map(([name, count]) => ({ name, count })) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function mergeMcps(target, source) {
  const map = new Map();
  for (const entry of [...target, ...source]) {
    for (const tool of entry.tools) addMcp(map, { name: entry.name, displayName: entry.displayName || entry.name, tool: tool.name }, tool.count);
  }
  return serializeMcps(map);
}

export function matchesPrimitive(rankings, filter) {
  if (!filter) return true;
  const entry = (rankings[filter.kind] ?? []).find((entry) => entry.name === filter.name);
  if (!entry) return false;
  if (filter.role) return (entry.roles?.[filter.role] ?? 0) > 0;
  if (filter.tool) return entry.tools?.some((tool) => tool.name === filter.tool && tool.count > 0) ?? false;
  return entry.count > 0;
}

export function primitiveLabel(filter) {
  const name = filter.label || filter.name;
  return `${name}${filter.role ? ` · ${ROLE_LABELS[filter.role]}` : filter.tool ? ` / ${filter.tool}` : ""}`;
}
