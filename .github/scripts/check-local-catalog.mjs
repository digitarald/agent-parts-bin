import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkLocalCatalog(root = process.cwd()) {
  const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const folders = existsSync(resolve(root, "plugins"))
    ? readdirSync(resolve(root, "plugins"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    : [];
  for (const folder of folders) {
    read(`plugins/${folder}/plugin.json`);
  }
  for (const plugin of read("marketplace.json").plugins) {
    const source = plugin?.source;
    const local = typeof source === "string" && source.trim().length > 0;
    const remote = source !== null && typeof source === "object" && !Array.isArray(source);
    if (!local && !remote) {
      throw new Error(`${plugin?.name ?? "(unnamed plugin)"}: source must be a non-empty local folder path or a remote source object.`);
    }
    if (!local) continue;
    const manifest = read(`${plugin.source}/plugin.json`);
    for (const field of ["name", "version", "description"]) {
      if (manifest[field] !== plugin[field]) {
        throw new Error(`${plugin.name}: marketplace.json and ${plugin.source}/plugin.json disagree on ${field}.`);
      }
    }
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  checkLocalCatalog();
  console.log("Local catalog entries match their plugin.json files.");
}
