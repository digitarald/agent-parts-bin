import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { createStore, defaultRoot, LIMITS, publicSummary, SourceError, validateId } from "./records.mjs";
import { startServer } from "./server.mjs";

const panels = new Map();
const keyFor = (ctx) => JSON.stringify([ctx.sessionId, ctx.instanceId]);
const objectSchema = (properties, required = []) => ({ type: "object", additionalProperties: false, properties, required });
const idSchema = { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" };
let session;

async function guard(fn) {
  try { return await fn(); }
  catch (error) {
    if (error instanceof CanvasError) throw error;
    const code = error instanceof SourceError ? error.code : "read_failed";
    await session?.log(`session-lens: ${code}`);
    throw new CanvasError(code, error instanceof SourceError ? error.message : "Could not open or read the session source. Check permissions and retry.");
  }
}
async function panelFor(ctx) {
  const panel = await panels.get(keyFor(ctx));
  if (!panel) throw new CanvasError("unknown_panel", "Open this canvas instance first.");
  return panel;
}

const canvas = createCanvas({
  id: "parts-bin-session-lens",
  displayName: "Session Lens",
  description: "Inspect local Copilot session usage, context evidence, tools, files, and agents without model calls.",
  inputSchema: objectSchema({
    sessionId: idSchema,
    sessionRoot: { type: "string", minLength: 1, description: "Explicit absolute path to a compatible session-state directory; defaults to Copilot home." },
  }),
  actions: [
    { name: "list_sessions", description: "List bounded recent session IDs and file timestamps, without conversation content.",
      handler: (ctx) => guard(async () => (await panelFor(ctx)).store.list()) },
    { name: "get_snapshot", description: "Refresh aggregate measurements for the selected session. Never returns message text, file paths, commands, or tool payloads.",
      handler: (ctx) => guard(async () => {
        const panel = await panelFor(ctx);
        if (!panel.selected) throw new CanvasError("no_selection", "Select a session first.");
        return publicSummary(await panel.store.read(panel.selected, true));
      }) },
    { name: "select_session", description: "Select a local session by its listed ID and return aggregate measurements.",
      inputSchema: objectSchema({ sessionId: idSchema }, ["sessionId"]),
      handler: (ctx) => guard(async () => {
        const id = validateId(ctx.input?.sessionId);
        const panel = await panelFor(ctx);
        const result = await panel.store.read(id);
        panel.selected = id;
        panel.view = "session";
        return publicSummary(result);
      }) },
  ],
  open: (ctx) => guard(async () => {
    const key = keyFor(ctx);
    if (ctx.input !== undefined && (ctx.input === null || typeof ctx.input !== "object" || Array.isArray(ctx.input))) {
      throw new CanvasError("invalid_input", "Open with an object containing optional sessionId and sessionRoot.");
    }
    if (!panels.has(key)) {
      const input = ctx.input ?? {};
      if (Object.keys(input).some((name) => !["sessionId", "sessionRoot"].includes(name))) throw new CanvasError("invalid_input", "Unknown canvas input.");
      const root = input.sessionRoot ?? defaultRoot();
      const store = createStore(root);
      const selected = input.sessionId === undefined ? null : validateId(input.sessionId);
      const pending = (async () => {
        await store.list();
        if (selected) await store.read(selected);
        const panel = { store, selected, view: selected ? "session" : "activity", root, limits: LIMITS };
        panel.server = await startServer(panel, (code) => session.log(`session-lens: ${code}`));
        return panel;
      })();
      panels.set(key, pending);
      try { await pending; }
      catch (error) { panels.delete(key); throw error; }
    }
    const panel = await panelFor(ctx);
    if (ctx.input?.sessionRoot !== undefined && ctx.input.sessionRoot !== panel.root) {
      throw new CanvasError("source_changed", "Use a new instanceId for a different source directory.");
    }
    if (ctx.input?.sessionId !== undefined) {
      const id = validateId(ctx.input.sessionId);
      await panel.store.read(id, true);
      panel.selected = id;
      panel.view = "session";
    }
    return { title: "Session Lens", url: panel.server.url };
  }),
  onClose: (ctx) => guard(async () => {
    const key = keyFor(ctx);
    const pending = panels.get(key);
    panels.delete(key);
    if (pending) await (await pending).server.close();
  }),
});

session = await joinSession({ canvases: [canvas] });
