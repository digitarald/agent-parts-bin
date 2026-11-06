import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

// True when this module is the script Node was asked to run. Compares real paths,
// because Node resolves import.meta.url through symlinks but leaves argv alone
// (for example macOS temp folders, where /var links to /private/var).
export function isEntrypoint(metaUrl) {
  return Boolean(process.argv[1]) && real(resolve(process.argv[1])) === real(fileURLToPath(metaUrl));
}
