import { isEntrypoint } from "./entrypoint.mjs";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));

// TypeScript sources that tsconfig.json includes (plugins/**/*.ts).
export async function typeScriptSources(directory = root) {
  try {
    return (await readdir(resolve(directory, "plugins"), { recursive: true }))
      .filter((path) => path.endsWith(".ts") && !path.split(/[\\/]/).includes("node_modules"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Type-checks plugin TypeScript. tsc fails when there are no inputs, which
// happens once you remove the only MCP server example, so skip it then.
// As the first step of npm run verify, it also checks that dependencies are installed.
async function main() {
  const require = createRequire(import.meta.url);
  let manifestPath;
  try {
    for (const name of ["ajv", "yaml", "@microsoft/vally-cli"]) require.resolve(`${name}/package.json`);
    manifestPath = require.resolve("typescript/package.json");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    console.error("Dependencies aren't installed. Run npm ci first, then try again.");
    process.exitCode = 1;
    return;
  }
  if (!(await typeScriptSources()).length) {
    console.log("No plugin TypeScript sources to type-check.");
    return;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin.tsc;
  const result = spawnSync(process.execPath, [resolve(dirname(manifestPath), bin), "--noEmit"], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (isEntrypoint(import.meta.url)) await main();
