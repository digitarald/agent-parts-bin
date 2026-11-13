import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync,
  rmdirSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { coauthor, contextVariable, parseContext } from './git-hook.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
const hookNames = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update',
  'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite',
  'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist',
  'p4-post-changelist', 'p4-pre-submit', 'post-index-change',
];

type Shell = 'bash' | 'powershell';
interface Context { version: number; sessionId: string; model?: string }
interface Installation { version: number; originalPath: string; previousLocalPath: string | null }
interface Event {
  sessionId: string;
  cwd: string;
  agentId?: string;
  toolName?: string;
  toolArgs?: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function message(error: unknown): string {
  if (error instanceof SyntaxError) return 'Invalid JSON in hook input or stored state. Correct it and retry.';
  return error instanceof Error ? error.message : String(error);
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function git(cwd: string, args: string[], missing = false): string | undefined {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
  });
  if (result.error) throw result.error;
  if (result.status === 0) return result.stdout.trim();
  if (missing && result.status === 1 && !result.stderr.trim()) return undefined;
  if (args[0] === 'rev-parse' && result.status === 128 && result.stderr.includes('not a git repository')) return undefined;
  throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellPath(value: string): string {
  return process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
}

function readInstallation(path: string): Installation {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!object(value) || value.version !== 1 || typeof value.originalPath !== 'string'
    || !(value.previousLocalPath === null || typeof value.previousLocalPath === 'string')) {
    throw new Error(`Invalid installation state at ${path}. Restore the previous Git hook configuration before retrying.`);
  }
  return { version: 1, originalPath: value.originalPath, previousLocalPath: value.previousLocalPath };
}

export function ensureInstalled(cwd: string): string | undefined {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top === undefined) return undefined;
  const common = git(top, ['rev-parse', '--git-common-dir']);
  if (common === undefined) throw new Error('Cannot locate Git metadata.');
  const location = resolve(top, common, 'copilot-commit-attribution');
  const hooks = join(location, 'hooks');
  const statePath = join(location, 'state.json');
  const currentPath = git(top, ['config', '--path', '--get', 'core.hooksPath'], true);
  const runtime = readFileSync(join(scripts, 'git-hook.mjs'), 'utf8');
  if (currentPath && resolve(top, currentPath) === hooks && existsSync(statePath)
    && existsSync(join(location, 'git-hook.mjs'))
    && existsSync(join(location, 'check.mjs'))
    && readFileSync(join(location, 'git-hook.mjs'), 'utf8') === runtime
    && hookNames.every(name => existsSync(join(hooks, name)))) {
    readInstallation(statePath);
    return location;
  }
  const lock = `${location}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (errno(error, 'EEXIST')) throw new Error('Git hook installation is already in progress. Retry after it completes.');
    throw error;
  }
  try {
    let state: Installation;
    if (existsSync(statePath)) {
      state = readInstallation(statePath);
      if (!currentPath || resolve(top, currentPath) !== hooks) {
        throw new Error(`core.hooksPath changed after installation. Restore or reconcile ${statePath} before retrying.`);
      }
    } else {
      if (existsSync(location)) throw new Error(`Refusing to overwrite an unrecognized installation at ${location}.`);
      if (currentPath && resolve(top, currentPath) === hooks) throw new Error('Refusing to chain the attribution dispatcher to itself.');
      state = {
        version: 1,
        originalPath: currentPath ?? resolve(top, common, 'hooks'),
        previousLocalPath: git(top, ['config', '--local', '--get', 'core.hooksPath'], true) ?? null,
      };
      mkdirSync(location);
    }
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(location, 'git-hook.mjs'), runtime);
    writeFileSync(join(location, 'check.mjs'), [
      "import { checkMessage } from './git-hook.mjs';",
      'try { checkMessage(process.argv[2]); }',
      'catch (error) { console.error(`commit-attribution: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }',
      '',
    ].join('\n'));
    for (const name of hookNames) {
      const original = state.originalPath ? shellPath(join(state.originalPath, name)) : '';
      const script = [
        '#!/bin/sh',
        '# Installed by commit-attribution; original hooks remain in their own directory.',
        `original=${posixQuote(original)}`,
        'if [ -n "$original" ] && [ -x "$original" ]; then',
        '  "$original" "$@" || exit $?',
        'fi',
        ...(name === 'commit-msg' ? [
          `if [ "\${${contextVariable}+set}" = set ]; then`,
          `  exec ${posixQuote(shellPath(process.execPath))} ${posixQuote(shellPath(join(location, 'check.mjs')))} "$@"`,
          'fi',
        ] : []),
        '',
      ].join('\n');
      const temporary = join(hooks, `${name}.${process.pid}.tmp`);
      writeFileSync(temporary, script, { mode: 0o755 });
      renameSync(temporary, join(hooks, name));
    }
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, statePath);
    git(top, ['config', '--local', 'core.hooksPath', shellPath(hooks)]);
    if (git(top, ['config', '--path', '--get', 'core.hooksPath'], true) !== shellPath(hooks)) {
      if (state.previousLocalPath === null) git(top, ['config', '--local', '--unset', 'core.hooksPath']);
      else git(top, ['config', '--local', 'core.hooksPath', state.previousLocalPath]);
      throw new Error('A higher-priority Git configuration overrides core.hooksPath; attribution is not active.');
    }
    return location;
  } finally {
    rmdirSync(lock);
  }
}

function eventFrom(value: unknown): Event {
  if (!object(value) || typeof value.sessionId !== 'string' || value.sessionId.length === 0
    || typeof value.cwd !== 'string' || !isAbsolute(value.cwd)
    || (value.agentId !== undefined && typeof value.agentId !== 'string')
    || (value.toolName !== undefined && typeof value.toolName !== 'string')) {
    throw new Error('Expected a native Copilot hook event with sessionId and absolute cwd.');
  }
  return {
    sessionId: value.sessionId, cwd: value.cwd,
    ...(typeof value.agentId === 'string' ? { agentId: value.agentId } : {}),
    ...(typeof value.toolName === 'string' ? { toolName: value.toolName } : {}),
    toolArgs: value.toolArgs,
  };
}

function sessionTail(path: string): unknown[] {
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, length).toString('utf8').split('\n');
    if (start > 0) lines.shift();
    lines.pop();
    return lines.filter(Boolean).map(line => JSON.parse(line));
  } finally {
    closeSync(fd);
  }
}

export function issuingModel(event: Event): { model?: string; diagnostic?: string } {
  if (basename(event.sessionId) !== event.sessionId || ['.', '..'].includes(event.sessionId)) {
    throw new Error('Invalid session ID for runtime event lookup.');
  }
  const path = join(process.env.COPILOT_HOME || join(homedir(), '.copilot'), 'session-state', event.sessionId, 'events.jsonl');
  let events: unknown[];
  try {
    events = sessionTail(path);
  } catch (error) {
    return { diagnostic: `Issuing model unavailable: ${message(error)}` };
  }
  const agentEvents = events.filter(value => object(value) && value.agentId === event.agentId);
  const starts = agentEvents.filter(value => object(value) && value.type === 'tool.execution_start');
  const latestStart = starts.at(-1);
  if (object(latestStart) && object(latestStart.data) && latestStart.data.toolName === event.toolName
    && isDeepStrictEqual(latestStart.data.arguments, event.toolArgs)
    && typeof latestStart.data.model === 'string' && latestStart.data.model !== 'auto') {
    return { model: latestStart.data.model };
  }
  const latestMessage = agentEvents.filter(value => object(value) && value.type === 'assistant.message').at(-1);
  if (object(latestMessage) && object(latestMessage.data) && Array.isArray(latestMessage.data.toolRequests)
    && latestMessage.data.toolRequests.some(request => object(request) && request.name === event.toolName
      && isDeepStrictEqual(request.arguments, event.toolArgs))
    && typeof latestMessage.data.model === 'string' && latestMessage.data.model !== 'auto') {
    return { model: latestMessage.data.model };
  }
  return { diagnostic: 'Issuing model unavailable: no matching runtime tool request with a resolved model.' };
}

export function beforeTool(value: unknown): Record<string, unknown> {
  const event = eventFrom(value);
  if (event.toolName !== 'bash' && event.toolName !== 'powershell') return {};
  const args: unknown = typeof event.toolArgs === 'string' ? JSON.parse(event.toolArgs) : event.toolArgs;
  if (!object(args) || typeof args.command !== 'string') throw new Error('Expected shell toolArgs.command.');
  if (!ensureInstalled(event.cwd)) return {};
  const { model, diagnostic } = issuingModel({ ...event, toolArgs: args });
  if (diagnostic) process.stderr.write(`commit-attribution: ${diagnostic}\n`);
  const context: Context = { version: 1, sessionId: event.sessionId, ...(model ? { model } : {}) };
  parseContext(context);
  return { modifiedArgs: { ...args, command: guardedCommand(event.toolName, args.command, context) } };
}

export function guardedCommand(shell: Shell, command: string, context: Context): string {
  const json = JSON.stringify(parseContext(context));
  const prefix = `__copilot_attribution_${randomBytes(6).toString('hex')}`;
  if (shell === 'bash') {
    return [
      `${prefix}_set="\${${contextVariable}+set}"`,
      `${prefix}_previous="\${${contextVariable}-}"`,
      `${prefix}_restore() {`,
      '  local original_status=$?',
      `  if [ "$${prefix}_set" = set ]; then`,
      `    export ${contextVariable}="$${prefix}_previous"`,
      '  else',
      `    unset ${contextVariable}`,
      '  fi',
      `  unset ${prefix}_set ${prefix}_previous`,
      `  unset -f ${prefix}_restore`,
      '  return "$original_status"',
      '}',
      `export ${contextVariable}=${posixQuote(json)}`,
      command,
      `${prefix}_restore`,
    ].join('\n');
  }
  const previous = `$${prefix}_previous`;
  const status = `$${prefix}_status`;
  return [
    `${previous} = [Environment]::GetEnvironmentVariable('${contextVariable}', 'Process')`,
    `${status} = 0`,
    'try {',
    `  $env:${contextVariable} = '${json.replaceAll("'", "''")}'`,
    command,
    `  if ($?) { ${status} = 0 } else {`,
    `    ${status} = if (Test-Path variable:LASTEXITCODE) { [int]$LASTEXITCODE } else { 1 }`,
    `    if (${status} -eq 0) { ${status} = 1 }`,
    '  }',
    '} finally {',
    `  [Environment]::SetEnvironmentVariable('${contextVariable}', ${previous}, 'Process')`,
    `  Remove-Variable ${prefix}_previous`,
    '}',
    `if (${status} -eq 0) {`,
    `  Remove-Variable ${prefix}_status`,
    '} else {',
    `  & '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(Number(process.argv[1]))' $(Get-Variable ${prefix}_status -ValueOnly; Remove-Variable ${prefix}_status)`,
    '}',
  ].join('\n');
}

export async function main(): Promise<void> {
  const mode = process.argv[2];
  let output: Record<string, unknown>;
  try {
    const event = eventFrom(JSON.parse(readFileSync(0, 'utf8')));
    if (mode === 'session-start') {
      const location = ensureInstalled(event.cwd);
      output = { additionalContext: location
        ? `Commit attribution is installed in Git metadata. Use the commit skill and include Co-authored-by: ${coauthor}. Existing valid session/model trailers are preserved. Fix and retry rejected messages; never bypass the guard.`
        : 'No Git repository found; commit attribution will be installed when a shell tool starts in a repository.' };
    } else if (mode === 'pre-tool') {
      output = beforeTool(event);
    } else throw new Error(`Unknown hook mode: ${mode}`);
  } catch (error) {
    const reason = `commit-attribution: ${message(error)}`;
    process.stderr.write(`${reason}\n`);
    if (mode === 'pre-tool') output = { permissionDecision: 'deny', permissionDecisionReason: reason };
    else {
      output = { additionalContext: `${reason} Attribution setup failed. Correct the integration before committing; do not bypass it.` };
      process.exitCode = 1;
    }
  }
  process.stdout.write(JSON.stringify(output));
}
