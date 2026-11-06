import { relative, sep } from "node:path";

// Collects every problem a check finds so a run reports them all at once as
// `path: message` lines, instead of stopping at the first failed assertion.
export class ValidationError extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.name = "ValidationError";
    this.problems = problems;
  }
}

// Bugs in a checker, as opposed to problems in the files it checks.
const isBug = (error) => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError;

export const relativePath = (directory, path) => relative(directory, path).split(sep).join("/");

export class Problems {
  constructor(directory) {
    this.directory = directory;
    this.list = [];
  }

  // Makes absolute paths under the repository relative, with forward slashes.
  clean(message) {
    if (!this.directory) return message;
    const base = this.directory.endsWith(sep) ? this.directory : this.directory + sep;
    const [first, ...rest] = message.split(base);
    return first + rest.map((part) => {
      const path = part.match(/^[^\s:'"`]+/)?.[0] ?? "";
      return path.split(sep).join("/") + part.slice(path.length);
    }).join("");
  }

  add(label, message) {
    const text = this.clean(String(message).trim());
    const prefix = label ? this.clean(label) : "";
    this.list.push(!prefix || text.startsWith(prefix) ? text : `${prefix}: ${text}`);
  }

  record(label, error) {
    if (isBug(error)) throw error;
    if (error instanceof ValidationError) for (const problem of error.problems) this.add(label, problem);
    else this.add(label, error?.message ?? error);
  }

  // Runs one check and records its failure instead of throwing.
  async check(label, fn) {
    try { return await fn(); }
    catch (error) { this.record(label, error); }
  }

  checkSync(label, fn) {
    try { return fn(); }
    catch (error) { this.record(label, error); }
  }

  throwIfAny() {
    if (this.list.length) throw new ValidationError([...new Set(this.list)]);
  }
}

// Runs a command-line check: prints each problem on its own line without a
// stack trace and sets a failing exit code. Checker bugs keep their stack.
export async function runCli(main) {
  try {
    await main();
  } catch (error) {
    if (isBug(error)) throw error;
    const problems = error instanceof ValidationError ? error.problems : [error?.message ?? String(error)];
    console.error(`Found ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const problem of problems) console.error(`  ${problem.replaceAll("\n", "\n    ")}`);
    process.exitCode = 1;
  }
}
