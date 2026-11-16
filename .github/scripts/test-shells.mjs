import { spawnSync } from "node:child_process";

const probe = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
  encoding: "utf8", timeout: 30_000,
});
if (probe.error?.code !== "ENOENT" && (probe.error || probe.status !== 0)) {
  throw probe.error ?? new Error(`PowerShell probe failed: ${probe.stderr}`);
}
if (probe.error && process.env.CI) throw probe.error;
export const powerShellSkip = probe.error ? "PowerShell is not installed; these recipes run in CI." : false;
