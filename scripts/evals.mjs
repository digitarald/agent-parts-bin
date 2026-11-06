import { isEntrypoint } from "./entrypoint.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, access } from "node:fs/promises";
import { resolve, delimiter, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedCases, parseTagSelectors, readVallyConfig, specsInSuite } from "./catalog.mjs";
import { runCli } from "./problems.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
const cliDirectory = resolve(root, "node_modules/@microsoft/vally-cli");
const manifest = JSON.parse(await readFile(resolve(cliDirectory, "package.json"), "utf8"));
export const vallyCliPath = resolve(cliDirectory, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.vally);
export const runtimeBridge = resolve(root, "scripts/eval-runtime.js");

// A string param whose value contains a slash is a repository-relative path.
// Other params, such as matrix values, pass through to Vally unchanged.
export const isPathParam = (value) => typeof value === "string" && value.includes("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);

// Absolute values for the relative path defaults in .vally.yaml. MCP processes
// don't necessarily start in this checkout, so evals always receive absolute paths.
export async function pathParams(directory = root) {
  const config = await readVallyConfig(directory);
  return Object.freeze(Object.fromEntries(Object.entries(config?.params ?? {})
    .filter(([, value]) => isPathParam(value))
    .map(([name, value]) => [name, resolve(directory, value)])));
}

export const evalParams = await pathParams();

export function runtimeEnvironment(base = process.env) {
  const env = { ...base };
  const key = Object.keys(base).find((name) => name.toLowerCase() === "path");
  for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
  return {
    ...env,
    PATH: [resolve(root, "node_modules/.bin"), key ? base[key] : ""].filter(Boolean).join(delimiter),
    COPILOT_CLI_PATH: runtimeBridge,
    VALLY_TELEMETRY_OPTOUT: "1",
  };
}

export function vallyArguments(command, args = [], params = evalParams) {
  if (!["eval", "lint", "grade"].includes(command)) throw new Error("Use eval, lint, or grade.");
  const defaults = command === "eval"
    ? ["--workers", "1", "--max-retries", "1", "--junit", "--output-dir", "vally-results"]
    : command === "lint" ? ["plugins", "--eval-spec", "evals", "--strict"] : [];
  const flags = Object.entries(params).flatMap(([name, value]) => ["--param", `${name}=${value}`]);
  return [vallyCliPath, command, ...defaults, ...flags, ...args];
}

export const usage = `Usage: node scripts/evals.mjs <command> [options] [Vally options]

Commands:
  eval            Run evals with real Copilot sessions. Costs AI credits.
  lint            Check skills and eval specs without a model (npm run eval:lint).
  grade           Re-grade saved evidence (npm run eval:grade).

Launcher options for eval and lint:
  --plugin <name>   Select every eval spec for a plugin: the specs under
                    evals/<name>/, including nested ones such as
                    evals/<name>/agent/eval.yaml, and any spec whose cases tag one
                    of its assets. Repeat it for several plugins.
  --list            With eval, print the specs and cases that would run, and the
                    commands to run and report on them, without starting a
                    session. It's free.

Any other options go to Vally, for example --suite smoke, --eval-spec <path>,
--tag <key=value>, --model <id>, or --require-pass. With no --suite,
--eval-spec, --plugin, or --tag, eval runs the full suite. --plugin and
--eval-spec work with --suite and --tag: the launcher turns the suite into the
spec list and tag filter Vally accepts. Run node scripts/evals.mjs eval --help
to also see Vally's own options.

Examples:
  node scripts/evals.mjs eval --plugin code-review --list
  node scripts/evals.mjs eval --plugin code-review --suite smoke
  node scripts/evals.mjs eval --tag control=negative --list
  npm run eval:report -- --plugin code-review`;

const slash = (path) => path.split(sep).join("/");

// Every spec that belongs to a plugin: anything under evals/<name>/, plus any
// other spec with a case that tags one of the plugin's assets.
export function specsForPlugins(names, specs, directory = root) {
  const selected = [];
  for (const name of names) {
    const owned = specs.filter(({ path, spec }) => {
      const where = slash(relative(resolve(directory, "evals"), path));
      return where.startsWith(`${name}/`) || (spec?.stimuli ?? []).some((stimulus) =>
        [stimulus?.tags?.assets].flat().some((id) => typeof id === "string" && id.split(":")[1]?.startsWith(`${name}/`)));
    });
    if (!owned.length) throw new Error(`No eval specs found for plugin ${name}. Expected one under evals/${name}/, or a case tagged with one of its assets.`);
    for (const item of owned) if (!selected.includes(item)) selected.push(item);
  }
  return selected;
}

// Splits launcher options from the arguments that go to Vally.
export function launcherOptions(args) {
  const plugins = [];
  const rest = [];
  let list = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--list") list = true;
    else if (arg === "--help" || arg === "-h") { help = true; rest.push(arg); }
    else if (arg === "--plugin" || arg.startsWith("--plugin=")) {
      const value = arg.includes("=") ? arg.slice("--plugin=".length) : args[++index];
      if (!value || value.startsWith("-")) throw new Error("--plugin needs a plugin name, such as --plugin code-review.");
      plugins.push(value);
    } else rest.push(arg);
  }
  return { plugins, list, help, rest };
}

const optionValues = (args, ...names) => args.flatMap((arg, index) => names.flatMap((name) =>
  arg === name ? [args[index + 1]] : arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []))
  .filter((value) => value !== undefined);

// Removes Vally's selection options (and their values) from an argument list.
const selectionOptions = ["--suite", "--eval-spec", "-e", "--tag"];
function withoutSelection(args) {
  const kept = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (selectionOptions.includes(arg)) index++;
    else if (!selectionOptions.some((name) => arg.startsWith(`${name}=`))) kept.push(arg);
  }
  return kept;
}

// Reads what a command line selects: a suite, eval specs (including the ones
// --plugin expands to), and --tag filters.
export function selection(args) {
  return {
    suite: optionValues(args, "--suite").at(-1),
    evalSpecs: optionValues(args, "--eval-spec", "-e"),
    tags: optionValues(args, "--tag"),
  };
}

// Vally rejects --suite with --eval-spec, and --tag with --suite. When --plugin,
// --eval-spec, or --tag narrows a suite, this rewrites the suite into what
// Vally accepts: its `evals` globs narrow the spec list, and its tag filter
// becomes --tag. With no selection at all, it runs the full suite.
export function vallySelection(args, config, { directory = root, specPaths = [] } = {}) {
  const { suite, evalSpecs, tags } = selection(args);
  if (!suite && !evalSpecs.length && !tags.length) {
    if (!config?.suites?.full) throw new Error("Choose what to run with --suite <name>, --plugin <name>, --eval-spec <path>, or --tag <key=value>.");
    return ["--suite", "full", ...args];
  }
  if (!suite || (!evalSpecs.length && !tags.length)) return args;
  const definition = config?.suites?.[suite];
  if (!definition) throw new Error(`Unknown suite ${suite}. Configured suites: ${Object.keys(config?.suites ?? {}).join(", ") || "none"}.`);
  let specs = evalSpecs;
  if (definition.evals) {
    // Vally can't combine a suite's globs with --tag, so list the specs they match.
    specs = specsInSuite(specs.length ? specs : specPaths, config, suite, directory);
    if (!specs.length) throw new Error(`None of the selected eval specs are in the ${suite} suite.`);
  }
  const filter = definition.filter ?? {};
  const own = parseTagSelectors(tags);
  const overlap = Object.keys(filter).filter((key) => key in own.include || key in own.exclude);
  if (overlap.length) throw new Error(`The ${suite} suite already filters on ${overlap.join(", ")}. Drop --suite or that --tag.`);
  return [
    ...specs.flatMap((path) => ["--eval-spec", path]),
    ...Object.entries(filter).flatMap(([key, value]) => ["--tag", `${key}=${[value].flat().join(",")}`]),
    ...tags.flatMap((tag) => ["--tag", tag]),
    ...withoutSelection(args),
  ];
}

// The eval:report options that select the same cases as a run.
export function reportArguments(args, plugins = []) {
  const { suite, evalSpecs, tags } = selection(args);
  return [
    ...(suite ? ["--suite", suite] : []),
    ...plugins.flatMap((name) => ["--plugin", name]),
    ...evalSpecs.flatMap((path) => ["--eval-spec", path]),
    ...tags.flatMap((tag) => ["--tag", tag]),
  ];
}

// What a paid run would select, using the same rules as the report.
export async function describeSelection(args, directory = root) {
  const { readEvals } = await import("./validate-evals.mjs");
  const config = await readVallyConfig(directory);
  const specs = await readEvals(directory, config);
  const { suite, evalSpecs, tags } = selection(args);
  if (!specs.length) return [];
  const cases = expectedCases(specs, config, { suite, evalSpecs, tags, directory });
  const chosen = specs.filter(({ spec }) => (spec?.stimuli ?? []).some((stimulus) => cases.has(stimulus.name)));
  return chosen.map(({ path, spec }) => ({
    path: slash(relative(directory, path)),
    cases: spec.stimuli.filter((stimulus) => cases.has(stimulus.name)).map((stimulus) => stimulus.name),
  }));
}

async function specPaths(config) {
  const { readEvals } = await import("./validate-evals.mjs");
  return (await readEvals(root, config)).map(({ path }) => slash(relative(root, path)));
}

async function main() {
  const [command, ...raw] = process.argv.slice(2);
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(usage);
    if (!command) process.exitCode = 1;
    return;
  }
  if (!["eval", "lint", "grade"].includes(command)) throw new Error(`Unknown command ${command}.\n\n${usage}`);
  const options = launcherOptions(raw);
  if (options.help) console.log(`${usage}\n\nVally's options for ${command}:\n`);
  let args = options.rest;
  let pluginSpecs = [];
  if (options.plugins.length) {
    if (command === "grade") throw new Error("--plugin works with eval and lint. For grade, pass Vally's own options.");
    const { readEvals } = await import("./validate-evals.mjs");
    pluginSpecs = specsForPlugins(options.plugins, await readEvals(root)).map(({ path }) => slash(relative(root, path)));
    args = [...pluginSpecs.flatMap((path) => ["--eval-spec", path]), ...args];
  }
  if (options.list) {
    if (command !== "eval") throw new Error("--list works with eval.");
    const config = await readVallyConfig(root);
    const chosen = await describeSelection(args);
    const total = chosen.reduce((sum, item) => sum + item.cases.length, 0);
    if (!total) return console.log("There are no eval specs yet, so nothing would run.");
    // Fails here, for free, on a combination Vally would reject.
    vallySelection(args, config, { specPaths: await specPaths(config) });
    console.log(`Would run ${total} case${total === 1 ? "" : "s"} from ${chosen.length} spec${chosen.length === 1 ? "" : "s"}. Each case runs at least one Copilot session.`);
    for (const item of chosen) {
      console.log(`  ${item.path}`);
      for (const name of item.cases) console.log(`    ${name}`);
    }
    // Show the commands as typed, with --plugin rather than its expanded specs.
    const { suite, evalSpecs, tags } = selection(args);
    const all = !suite && !evalSpecs.length && !tags.length ? ["--suite", "full"] : [];
    const run = [...all, ...options.plugins.flatMap((name) => ["--plugin", name]), ...options.rest];
    const report = [...all, ...reportArguments(options.rest, options.plugins)];
    console.log(`\nTo run them (costs AI credits):\n  node scripts/evals.mjs eval ${run.join(" ")}`);
    console.log(`Then report on the same selection:\n  npm run eval:report${report.length ? ` -- ${report.join(" ")}` : ""}`);
    return;
  }
  if (command === "lint" && !args.length && !existsSync(resolve(root, "plugins"))) {
    const { readEvals } = await import("./validate-evals.mjs");
    if (!(await readEvals(root)).length) {
      console.log("No plugins or eval specs to lint yet. Add a plugin with npm run new-plugin -- <name>.");
      return;
    }
    throw new Error("plugins/ doesn't exist, but evals/ has eval specs. Add the plugins they cover, or remove the specs.");
  }
  await access(resolve(root, "node_modules/@github/copilot/npm-loader.js"));
  for (const [name, path] of Object.entries(evalParams)) {
    try { await access(path); }
    catch { throw new Error(`.vally.yaml param ${name} points to a missing path: ${path}. Run npm run build or update .vally.yaml.`); }
  }
  const params = Object.entries(evalParams).flatMap(([name, value]) => ["--param", `${name}=${value}`]);
  let runs;
  if (command === "lint" && options.plugins.length) {
    // Vally's lint takes one --eval-spec and lints skills only when given a
    // path, so lint each plugin's skills and each of its specs separately.
    const extra = withoutSelection(options.rest);
    runs = [
      ...options.plugins.filter((name) => existsSync(resolve(root, "plugins", name, "skills")))
        .map((name) => [vallyCliPath, "lint", `plugins/${name}`, ...params, ...extra, "--strict"]),
      ...pluginSpecs.map((path) => [vallyCliPath, "lint", "--eval-spec", path, ...params, ...extra, "--strict"]),
    ];
  } else if (command === "eval") {
    const config = await readVallyConfig(root);
    runs = [vallyArguments(command, options.help ? args : vallySelection(args, config, { specPaths: await specPaths(config) }))];
  } else runs = [vallyArguments(command, args)];
  let stopping = false;
  for (const vally of runs) {
    const code = await new Promise((done) => {
      const child = spawn(process.execPath, vally, { cwd: root, stdio: "inherit", env: runtimeEnvironment() });
      const forward = (signal) => () => { stopping = true; child.kill(signal); };
      const onInt = forward("SIGINT");
      const onTerm = forward("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      child.on("error", (error) => { console.error(error); done(1); });
      child.on("exit", (exitCode, signal) => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        if (signal) console.error(`Vally terminated by ${signal}.`);
        done(exitCode ?? 1);
      });
    });
    if (code !== 0) process.exitCode = code;
    if (stopping) break;
  }
}

if (isEntrypoint(import.meta.url)) await runCli(main);