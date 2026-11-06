import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const skill = fileURLToPath(new URL("../plugins/decide/skills/decide/", import.meta.url));

test("Decide's bundled CLI passes its offline contract and privacy tests", { skip: !existsSync(skill) }, () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    ["-B", "-m", "unittest", "discover", "-s", "tests", "-v"], {
      cwd: skill,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
