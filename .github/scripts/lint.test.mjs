import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function fixture(t) {
  const directory = resolve(root, ".github/scripts", `.lint-test-${randomUUID()}`);
  mkdirSync(directory);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("lint.mjs validates a plugins-only marketplace and check-remote-pins handles catalogs with no remote entries", (t) => {
  const directory = fixture(t);
  const pluginDir = resolve(directory, "plugins/sample-tool");
  const skillDir = resolve(pluginDir, "skills/sample-tool");
  mkdirSync(skillDir, { recursive: true });

  const manifest = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "sample-tool",
    version: "0.1.0",
    description: "Summarize synthetic release checklists.",
  };
  writeFileSync(resolve(pluginDir, "plugin.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    resolve(skillDir, "SKILL.md"),
    [
      "---",
      "name: sample-tool",
      'description: "Summarize synthetic release checklists when asked to format a release checklist."',
      "---",
      "",
      "# Sample tool",
      "",
      "Summarize the supplied checklist items concisely.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    resolve(directory, "marketplace.json"),
    JSON.stringify({
      name: "sample-marketplace",
      owner: { name: "Synthetic" },
      plugins: [{
        name: manifest.name,
        source: "./plugins/sample-tool",
        version: manifest.version,
        description: manifest.description,
      }],
    }, null, 2),
  );

  const lintResult = spawnSync(process.execPath, [resolve(root, ".github/scripts/lint.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, VALLY_TELEMETRY_OPTOUT: "1" },
  });
  assert.ifError(lintResult.error);
  assert.equal(lintResult.status, 0, `${lintResult.stdout}${lintResult.stderr}`);
  assert.match(lintResult.stdout, /sample-tool/);

  const pinsResult = spawnSync(process.execPath, [resolve(root, ".github/scripts/check-remote-pins.mjs")], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(pinsResult.error);
  assert.equal(pinsResult.status, 0, pinsResult.stderr);
  assert.match(pinsResult.stdout, /No remote pins to check\./);
});
