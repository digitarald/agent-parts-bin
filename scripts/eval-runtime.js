import { isEntrypoint } from "./entrypoint.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK launches .js entry points with Node; this forwards to the pinned full Copilot runtime.
// Defaults resolve from this checkout so hosted runners only need COPILOT_CLI_PATH pointing here.
const root = fileURLToPath(new URL("../", import.meta.url));
export const defaultRuntime = resolve(root, "node_modules/@github/copilot/npm-loader.js");

function absolute(value, fallback, name) {
  const path = value ?? fallback;
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path.`);
  return path;
}

// STARTER_PLUGIN_DIRS is a comma-separated list of plugin directories to mount
// with --plugin-dir, relative to the repository root or absolute. Evals set it in
// agent_environment.env so hook plugins load without a global installation.
// Commas, not the OS path delimiter, keep one eval file valid on every platform.
export function pluginDirectories(env = process.env) {
  return (env.STARTER_PLUGIN_DIRS ?? "").split(",").map((value) => value.trim()).filter(Boolean)
    .map((value) => isAbsolute(value) ? value : resolve(root, value));
}

export function runtimeArguments(args, env = process.env) {
  const flags = ["--disable-builtin-mcps", "--no-ask-user"];
  for (const directory of pluginDirectories(env)) flags.push("--plugin-dir", directory);
  return [...flags, ...args];
}

export function runtimeEntry(env = process.env) {
  return absolute(env.STARTER_COPILOT_CLI, defaultRuntime, "STARTER_COPILOT_CLI");
}

// The version in the runtime package's package.json, which npm installed from the lockfile.
export function packageVersion(entry = runtimeEntry()) {
  return JSON.parse(readFileSync(resolve(dirname(entry), "package.json"), "utf8")).version;
}

// Copilot CLI auto-update downloads newer releases into a package cache and then
// launches the newest one, so the pinned package can report a later version.
// Turning it off makes the CLI run the binary npm installed. CI turns it off by
// default; set COPILOT_AUTO_UPDATE yourself to override.
export function runtimeProcessEnvironment(env = process.env) {
  return { ...env, COPILOT_AUTO_UPDATE: env.COPILOT_AUTO_UPDATE ?? "false" };
}

if (isEntrypoint(import.meta.url)) {
  const args = process.argv.slice(2);
  // A version check reports both the pinned package and what actually runs.
  if (args.length === 1 && args[0] === "--version") console.log(`Pinned @github/copilot package: ${packageVersion()}`);
  const child = spawn(process.execPath, [runtimeEntry(), ...runtimeArguments(args)], {
    stdio: "inherit", windowsHide: true, env: runtimeProcessEnvironment(),
  });
  child.on("error", (error) => { console.error(error); process.exitCode = 1; });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`Copilot runtime terminated by ${signal}.`);
    process.exitCode = code ?? 1;
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
