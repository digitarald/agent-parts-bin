export const CATEGORIES = Object.freeze([
  { id: "system", label: "System instructions" },
  { id: "schemas", label: "Tool definitions" },
  { id: "user", label: "User messages" },
  { id: "injected", label: "Injected context" },
  { id: "skills", label: "Skill content" },
  { id: "assistant", label: "Assistant answers" },
  { id: "reasoning", label: "Reasoning" },
  { id: "calls", label: "Tool arguments" },
  { id: "results", label: "Tool results" },
  { id: "other", label: "Unattributed" },
]);

export const validCount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const count = (value, basis = "recorded", method = "Recorded in the session log") =>
  validCount(value) ? { value, basis, method } : { value: null, basis: "unknown", method: "Not captured" };

// A replaceable fallback, not a model tokenizer. No framing or image cost is invented.
export function estimateText(value) {
  if (typeof value !== "string") return count(null);
  let units = 0;
  for (const character of value) units += character.codePointAt(0) < 128 ? 0.25 : 1;
  return count(Math.ceil(units), "estimated", "Text heuristic: ASCII characters / 4 + non-ASCII code points; excludes framing and media");
}

export function sumCounts(values) {
  const known = values.filter((item) => item?.value !== null && item?.value !== undefined);
  if (!known.length) return count(null);
  const partial = known.length !== values.length;
  const basis = partial ? "partial" : known.every((item) => item.basis === "recorded") ? "recorded" : "estimated";
  return count(known.reduce((sum, item) => sum + item.value, 0), basis, partial ? "Known subtotal; some counts are missing" : "Sum of component counts");
}

export function contentComposition(weights) {
  const parts = CATEGORIES.filter(({ id }) => !["system", "schemas", "other"].includes(id)).map(({ id, label }) => ({
    id, label, tokens: count(weights[id] ?? 0, "estimated", "Estimated from recorded text only; excludes missing content"),
  }));
  const total = parts.reduce((sum, part) => sum + part.tokens.value, 0);
  return { total: count(total, "estimated", "Recorded text estimate, not the full model prompt"), chartTotal: total, parts };
}

export function composition(weights, recorded = {}, total = null) {
  const components = Object.fromEntries(Object.entries(recorded).map(([id, value]) => [id, typeof value === "number" ? count(value) : value]));
  const fixed = CATEGORIES.filter(({ id }) => validCount(components[id]?.value));
  const fixedTotal = fixed.reduce((sum, { id }) => sum + components[id].value, 0);
  const conflict = validCount(total) && fixedTotal > total;
  const eligible = CATEGORIES.filter(({ id }) => !validCount(components[id]?.value) && id !== "other" && (weights[id] ?? 0) > 0);
  const weightTotal = eligible.reduce((sum, { id }) => sum + weights[id], 0);
  const anchored = validCount(total) && !conflict;
  const remainder = anchored ? total - fixedTotal : null;
  let allocated = 0;
  const allocation = new Map(eligible.map(({ id }, index) => {
    const value = index === eligible.length - 1 ? remainder - allocated : Math.floor(remainder * weights[id] / weightTotal);
    allocated += value;
    return [id, value];
  }));
  const parts = CATEGORIES.map(({ id, label }) => {
    let tokens;
    if (validCount(components[id]?.value)) tokens = components[id];
    else if (anchored && allocation.has(id)) tokens = count(allocation.get(id), "attributed", "Proportional allocation of recorded prompt remainder using text estimates; membership is reconstructed");
    else if (id === "other" && anchored) tokens = count(weightTotal ? 0 : remainder, "derived", "Recorded prompt minus recorded components");
    else tokens = weights[id] === undefined ? count(null) : count(weights[id], "estimated", "Sum of text estimates from observed items; not confirmed prompt membership");
    return { id, label, tokens };
  });
  return {
    total: validCount(total) ? count(total) : sumCounts(parts.map((part) => part.tokens)),
    chartTotal: parts.reduce((sum, part) => sum + (part.tokens.value ?? 0), 0),
    parts, conflict, anchored,
  };
}

export function deltaParts(current, previous) {
  return current.parts.map((part) => {
    const before = previous?.parts.find((candidate) => candidate.id === part.id)?.tokens;
    return { ...part, value: before?.value != null && part.tokens.value != null ? part.tokens.value - before.value : null };
  });
}
