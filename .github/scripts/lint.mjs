import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { checkLocalCatalog } from "./check-local-catalog.mjs";

checkLocalCatalog();
const args = [];
if (existsSync("plugins")) args.push("plugins");
if (existsSync("evals")) args.push("--eval-spec", "evals");

if (args.length) {
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [
    require.resolve("@microsoft/vally-cli/dist/index.js"), "lint", ...args, "--strict",
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  console.log("No local skills or evals to lint.");
}
