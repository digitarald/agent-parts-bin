import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const pathFields = {
  create: "path",
  edit: "path",
  create_file: "filePath",
  replace_string_in_file: "filePath",
};

const maxMessage = 500;

// Node's JSON.parse messages can quote part of the input, which may hold
// secrets. Diagnostics name only the position, never the content.
export function jsonError(error, text) {
  if (!(error instanceof SyntaxError)) return error;
  const position = Number(error.message.match(/at position (\d+)/)?.[1]);
  if (!Number.isInteger(position) || typeof text !== "string") return new Error("Isn't valid JSON.");
  const before = text.slice(0, position).split(/\r\n|\r|\n/);
  return new Error(`Isn't valid JSON (line ${before.length}, column ${before.at(-1).length + 1}).`);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const safe = jsonError(error, text);
    throw label ? new Error(`${label}: ${safe.message}`) : safe;
  }
}

// --indent N sets the indentation, from 1 to 10 spaces. Anything else is
// rejected rather than ignored, so a typo in hooks.json can't pass silently.
export function options(args) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { indent: { type: "string", default: "2" } }, strict: true, allowPositionals: false }));
  } catch {
    throw new Error("Unsupported arguments. format-json accepts only --indent N, where N is 1 to 10.");
  }
  if (!/^(?:[1-9]|10)$/.test(values.indent)) throw new Error("--indent must be a whole number from 1 to 10.");
  return { indent: Number(values.indent) };
}

function filePath(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a non-empty file path.");
  return value;
}

function patchPaths(patch) {
  if (typeof patch !== "string" || !patch.startsWith("*** Begin Patch")
    || !patch.trimEnd().endsWith("*** End Patch")) {
    throw new Error("Expected an apply_patch patch.");
  }
  const paths = [];
  let current;
  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header || line === "*** End Patch") {
      if (current) paths.push(current);
      current = header && header[1] !== "Delete" ? filePath(header[2]) : undefined;
    } else if (line.startsWith("*** Move to: ") && current) {
      current = filePath(line.slice("*** Move to: ".length));
    }
  }
  return paths;
}

function affectedPaths(name, args) {
  if (typeof args === "string" && !(name === "apply_patch" && args.startsWith("*** Begin Patch"))) {
    args = parseJson(args, "toolArgs");
  }
  if (name === "apply_patch") return patchPaths(typeof args === "string" ? args : args?.input ?? args?.patch);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Expected toolArgs object.");
  if (name === "multi_replace_string_in_file") {
    if (!Array.isArray(args.replacements)) throw new Error("Expected replacements array.");
    return args.replacements.map((replacement) => filePath(replacement?.filePath));
  }
  return [filePath(args[pathFields[name]])];
}

export function format(event, diagnostic = console.error, { indent = 2 } = {}) {
  const messages = [];
  const report = (message) => {
    const text = `format-json: ${message}`.slice(0, maxMessage);
    messages.push(text);
    diagnostic(text);
  };
  try {
    if (!event || typeof event.toolName !== "string") throw new Error("Expected a Copilot CLI tool event with toolName.");
    const name = event.toolName;
    if (!Object.hasOwn(pathFields, name) && !["multi_replace_string_in_file", "apply_patch"].includes(name)) return {};
    if (event.toolResult?.resultType !== "success") return {};
    if (typeof event.cwd !== "string" || !isAbsolute(event.cwd)) throw new Error("Expected an absolute event cwd.");
    const paths = [...new Set(affectedPaths(name, event.toolArgs).map((path) => resolve(event.cwd, path)))];
    for (const path of paths) {
      if (extname(path).toLowerCase() !== ".json") continue;
      try {
        const local = relative(event.cwd, path);
        if (isAbsolute(local) || local.split(sep).includes("..")) throw new Error("File is outside the session working directory.");
        if (!lstatSync(path).isFile()) throw new Error("Expected a regular file, not a directory or symbolic link.");
        const actual = relative(realpathSync(event.cwd), realpathSync(path));
        if (isAbsolute(actual) || actual.split(sep).includes("..")) throw new Error("File resolves outside the session working directory.");
        const before = readFileSync(path, "utf8");
        const after = `${JSON.stringify(parseJson(before), null, indent)}\n`;
        if (before !== after) {
          writeFileSync(path, after);
          messages.push(`format-json: Formatted ${path}. Re-read it before further edits.`);
        }
      } catch (error) {
        report(`${path}: ${error.message}`);
      }
    }
  } catch (error) {
    report(error.message);
  }
  return messages.length ? { additionalContext: messages.join("\n") } : {};
}

// Compare real paths: Node resolves import.meta.url through symlinks but not argv.
const realOrResolved = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] && realOrResolved(resolve(process.argv[1])) === realOrResolved(fileURLToPath(import.meta.url))) {
  let result;
  try {
    const settings = options(process.argv.slice(2));
    result = format(parseJson(readFileSync(0, "utf8"), "Hook input"), console.error, settings);
  } catch (error) {
    const message = `format-json: ${error.message}`.slice(0, maxMessage);
    console.error(message);
    result = { additionalContext: message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
