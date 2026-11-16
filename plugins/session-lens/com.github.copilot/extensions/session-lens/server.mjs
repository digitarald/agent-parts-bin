import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { SourceError } from "./records.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/client.js", ["client.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/tokens.mjs", ["tokens.mjs", "text/javascript; charset=utf-8"]],
  ["/context-view.mjs", ["context-view.mjs", "text/javascript; charset=utf-8"]],
  ["/ui.mjs", ["ui.mjs", "text/javascript; charset=utf-8"]],
  ["/activity.mjs", ["activity.mjs", "text/javascript; charset=utf-8"]],
  ["/activity-view.mjs", ["activity-view.mjs", "text/javascript; charset=utf-8"]],
  ["/primitives.mjs", ["primitives.mjs", "text/javascript; charset=utf-8"]],
  ["/primitives-view.mjs", ["primitives-view.mjs", "text/javascript; charset=utf-8"]],
]);

export async function startServer(panel, log) {
  const cookie = randomBytes(32).toString("hex");
  const cookieName = `session-lens-${randomBytes(8).toString("hex")}`;
  const contents = new Map(await Promise.all([...assets].map(async ([route, [file, type]]) =>
    [route, { body: await readFile(new URL(file, import.meta.url)), type }])));
  let busy = false;
  const server = createServer((request, response) => {
    void handle(request, response).catch(async (error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ error: "Could not read the source. Refresh or check source permissions." }));
      } else response.destroy();
      await log(error instanceof SourceError ? error.code : "unexpected_server_error");
    });
  });
  async function handle(request, response) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
    };
    const send = (status, body, type = "application/json") => {
      response.writeHead(status, { ...headers, "Content-Type": type });
      response.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    if (request.headers.host !== new URL(origin).host ||
        request.headers.origin && request.headers.origin !== origin ||
        request.headers["sec-fetch-site"] === "cross-site") return send(403, { error: "Origin not allowed." });
    if (request.method !== "GET") return send(405, { error: "Read-only endpoint." });
    const url = new URL(request.url, origin);
    if (assets.has(url.pathname)) {
      const asset = contents.get(url.pathname);
      if (url.pathname === "/") response.setHeader("Set-Cookie", `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
      return send(200, asset.body, asset.type);
    }
    if (!request.headers.cookie?.split(";").some((part) => part.trim() === `${cookieName}=${cookie}`)) return send(403, { error: "Open the canvas before reading data." });
    if (busy) return send(429, { error: "A read is in progress. Try again shortly." });
    busy = true;
    try {
      if (url.pathname === "/api/state") return send(200, { selected: panel.selected, view: panel.view ?? "activity", limits: panel.limits });
      if (url.pathname === "/api/sessions") return send(200, await panel.store.list());
      if (url.pathname === "/api/overview") return send(200, await panel.store.overview({
        timeZone: url.searchParams.get("timeZone") ?? "UTC", scanId: url.searchParams.get("scanId") ?? undefined,
        offset: Number(url.searchParams.get("offset") ?? 0),
        historyDays: Number(url.searchParams.get("historyDays") ?? 30),
      }));
      if (url.pathname === "/api/navigation") {
        if (url.searchParams.get("view") !== "activity") throw new SourceError("invalid_view", "Choose Activity or select a session.");
        panel.view = "activity";
        return send(200, { view: panel.view });
      }
      if (url.pathname === "/api/session") {
        const id = url.searchParams.get("id") || panel.selected;
        if (!id) throw new SourceError("no_selection", "Select a session to inspect.");
        const value = await panel.store.read(id, url.searchParams.get("refresh") === "1");
        panel.selected = id;
        panel.view = "session";
        return send(200, value);
      }
      if (url.pathname === "/api/detail") {
        if (url.searchParams.get("reveal") !== "1") return send(403, { error: "Enable local content preview first." });
        return send(200, await panel.store.detail(url.searchParams.get("id"), Number(url.searchParams.get("line"))));
      }
      return send(404, { error: "Not found." });
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      return send(400, { code: error.code, error: error.message });
    } finally { busy = false; }
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", () => { void log("http_server_error"); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
