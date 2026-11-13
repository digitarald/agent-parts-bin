import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { beforeTool, ensureInstalled, guardedCommand, issuingModel } from '../plugins/commit-attribution/scripts/attribution-impl.mts';
import { coauthor, contextVariable } from '../plugins/commit-attribution/scripts/git-hook.mjs';

const scripts = fileURLToPath(new URL('../plugins/commit-attribution/scripts/', import.meta.url));
const entrypoint = join(scripts, 'attribution.mts');
const attributed = `Test commit\n\nCo-authored-by: ${coauthor}\n`;
const context = { version: 1, sessionId: 'session-one', model: 'test-model-one' };

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'copilot-attribution-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo with spaces and 'quotes'");
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = {
    ...process.env, GIT_CONFIG_GLOBAL: join(root, 'absent-global-config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  };
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    const previous = process.env[key];
    process.env[key] = env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', contextVariable]) delete env[key];
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'commit.gpgsign', 'false');
  return { root, repo, env, git, agentEnv: { ...env, [contextVariable]: JSON.stringify(context) } };
}

test('installed package starts and enforces attribution without the monorepo or node_modules', t => {
  const f = fixture(t);
  const installed = join(f.root, 'installed', 'commit-attribution');
  cpSync(dirname(scripts), installed, { recursive: true });
  const script = join(installed, 'scripts', 'attribution.mts');
  const start = spawnSync(process.execPath, [script, 'session-start'], {
    cwd: f.repo, env: f.env, encoding: 'utf8',
    input: JSON.stringify({ sessionId: 'installed-session', cwd: f.repo, source: 'startup' }),
  });
  assert.equal(start.status, 0, start.stderr);
  assert.match(JSON.parse(start.stdout).additionalContext, /Commit attribution is installed/);
  const before = spawnSync(process.execPath, [script, 'pre-tool'], {
    cwd: f.repo, env: { ...f.env, COPILOT_HOME: join(f.root, 'empty-copilot-home') }, encoding: 'utf8',
    input: JSON.stringify({ sessionId: 'installed-session', cwd: f.repo, toolName: 'bash', toolArgs: { command: 'git status' } }),
  });
  assert.equal(before.status, 0, before.stderr);
  assert.equal(typeof JSON.parse(before.stdout).modifiedArgs.command, 'string');
  const missing = spawnSync('git', ['commit', '--allow-empty', '-m', 'No attribution'], {
    cwd: f.repo, env: f.agentEnv, encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing attribution/);
  const valid = spawnSync('git', ['commit', '--allow-empty', '-m', attributed], {
    cwd: f.repo, env: f.agentEnv, encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Session-Id: session-one/);
});

test('real Git refuses missing/body-only attribution without creating HEAD', t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  for (const text of ['No attribution', `Body mentions Co-authored-by: ${coauthor}\n\nNot a trailer.`]) {
    const result = spawnSync('git', ['commit', '--allow-empty', '-m', text], { cwd: f.repo, env: f.agentEnv, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing attribution/);
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: f.repo, env: f.env }).status, 0);
  }
});

test('actual commits from inline, file, stdin, and child-script messages receive trailers', t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  const path = join(f.root, 'message.txt');
  writeFileSync(path, `${attributed}Signed-off-by: Test <test@example.invalid>\n`);
  const variants = [
    { args: ['-m', attributed] },
    { args: ['-F', path] },
    { args: ['-F', '-'], input: attributed },
  ];
  for (const variant of variants) {
    const result = spawnSync('git', ['commit', '--allow-empty', ...variant.args], {
      cwd: f.repo, env: f.agentEnv, encoding: 'utf8', input: variant.input,
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = f.git('log', '-1', '--format=%B');
    assert.match(actual, /Copilot-Session-Id: session-one/);
    assert.match(actual, /Copilot-Model: test-model-one/);
    if (variant.args[1] === path) assert.match(actual, /Signed-off-by: Test/);
  }
  execFileSync(process.execPath, ['-e',
    `require('node:child_process').execFileSync('git', ['commit', '--allow-empty', '-F', '-'], { input: ${JSON.stringify(attributed)} });`,
  ], { cwd: f.repo, env: f.agentEnv, stdio: 'pipe' });
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Session-Id: session-one/);
});

test('valid historical attribution survives requested amendments and cherry-picks', t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  const historical = `${attributed}Copilot-Session-Id: previous-session\nCopilot-Model: previous-model`;
  execFileSync('git', ['commit', '--allow-empty', '-m', historical], { cwd: f.repo, env: f.agentEnv, stdio: 'pipe' });
  const first = f.git('rev-parse', 'HEAD');
  execFileSync('git', ['commit', '--amend', '--no-edit', '--allow-empty'], { cwd: f.repo, env: f.agentEnv, stdio: 'pipe' });
  assert.equal(f.git('log', '-1', '--format=%B'), historical);
  f.git('checkout', '--orphan', 'picked');
  execFileSync('git', ['cherry-pick', '--allow-empty', first], { cwd: f.repo, env: f.agentEnv, stdio: 'pipe' });
  assert.equal(f.git('log', '-1', '--format=%B'), historical);
});

test('human commits are unchanged, unavailable models are explicit, invalid context is refused', t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  f.git('commit', '--allow-empty', '-m', 'Human commit');
  assert.equal(f.git('log', '-1', '--format=%B'), 'Human commit');
  const result = spawnSync('git', ['commit', '--allow-empty', '-m', attributed], {
    cwd: f.repo, env: { ...f.env, [contextVariable]: JSON.stringify({ version: 1, sessionId: 'known-session' }) }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Issuing model unavailable/);
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Session-Id: known-session/);
  assert.doesNotMatch(f.git('log', '-1', '--format=%B'), /Copilot-Model:/);
  const head = f.git('rev-parse', 'HEAD');
  const invalid = spawnSync('git', ['commit', '--allow-empty', '-m', attributed], {
    cwd: f.repo, env: { ...f.env, [contextVariable]: '{}' }, encoding: 'utf8',
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid Copilot attribution context/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
});

test('custom tracked hooks retain stdin, ordering, message edits, and failures', t => {
  const f = fixture(t);
  const hooks = join(f.repo, 'team hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > .git/pre-commit-ran\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\ngit interpret-trailers --in-place --trailer "Signed-off-by: Existing <existing@example.invalid>" "$1"\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\ncat > .git/push-input\nexit 7\n', { mode: 0o755 });
  f.git('add', 'team hooks');
  f.git('commit', '-qm', 'Track original hooks');
  f.git('config', 'core.hooksPath', 'team hooks');
  const original = readFileSync(join(hooks, 'commit-msg'), 'utf8');
  const location = ensureInstalled(f.repo);
  assert.ok(location);
  const state = readFileSync(join(location, 'state.json'), 'utf8');
  ensureInstalled(f.repo);
  assert.equal(readFileSync(join(location, 'state.json'), 'utf8'), state);
  assert.equal(JSON.parse(state).previousLocalPath, 'team hooks');
  const result = spawnSync('git', ['commit', '--allow-empty', '-m', attributed], { cwd: f.repo, env: f.agentEnv, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.repo, '.git/pre-commit-ran'), 'utf8'), 'ran');
  assert.match(f.git('log', '-1', '--format=%B'), /Signed-off-by: Existing/);
  assert.equal(readFileSync(join(hooks, 'commit-msg'), 'utf8'), original);
  assert.equal(f.git('status', '--porcelain'), '');
  const push = spawnSync('sh', [join(location, 'hooks/pre-push'), 'origin', 'unused'], {
    cwd: f.repo, env: f.env, input: 'original hook stdin\n', encoding: 'utf8',
  });
  assert.equal(push.status, 7, push.stderr);
  assert.equal(readFileSync(join(f.repo, '.git/push-input'), 'utf8'), 'original hook stdin\n');
  f.git('config', 'core.hooksPath', 'another-manager');
  assert.throws(() => ensureInstalled(f.repo), /changed after installation/);
  assert.equal(f.git('config', 'core.hooksPath'), 'another-manager');
});

test('model lookup matches the current agent request, never configured or unrelated defaults', t => {
  const f = fixture(t);
  const previous = process.env.COPILOT_HOME;
  process.env.COPILOT_HOME = join(f.root, 'copilot-home');
  t.after(() => { if (previous === undefined) delete process.env.COPILOT_HOME; else process.env.COPILOT_HOME = previous; });
  const event = { cwd: f.repo, sessionId: 'test-session', toolName: 'bash', toolArgs: { command: 'git status', shellId: 'session' } };
  const directory = join(process.env.COPILOT_HOME, 'session-state', event.sessionId);
  mkdirSync(directory, { recursive: true });
  const log = join(directory, 'events.jsonl');
  const writeEvents = (events: unknown[]) => writeFileSync(log, `${events.map(value => JSON.stringify(value)).join('\n')}\n`);
  writeEvents([
    { type: 'session.start', data: { selectedModel: 'configured-default' } },
    { type: 'tool.execution_start', data: { toolName: 'bash', arguments: event.toolArgs, model: 'actual-model' } },
    { type: 'tool.execution_start', agentId: 'another-agent', data: { toolName: 'bash', arguments: event.toolArgs, model: 'wrong-agent-model' } },
  ]);
  assert.equal(issuingModel(event).model, 'actual-model');
  writeEvents([{ type: 'assistant.message', data: { model: 'switched-model', toolRequests: [{ name: 'bash', arguments: event.toolArgs }] } }]);
  assert.equal(issuingModel(event).model, 'switched-model');
  writeEvents([{ type: 'assistant.message', data: { model: 'unrelated', toolRequests: [{ name: 'view', arguments: {} }] } }]);
  assert.equal(issuingModel(event).model, undefined);
  assert.match(issuingModel(event).diagnostic ?? '', /unavailable/);
  writeEvents([{ type: 'tool.execution_start', data: { toolName: 'bash', arguments: event.toolArgs, model: 'auto' } }]);
  assert.equal(issuingModel(event).model, undefined);
  const decision = beforeTool(event);
  assert.ok('modifiedArgs' in decision);
  assert.equal('permissionDecision' in decision, false);
  const args = decision.modifiedArgs;
  assert.ok(args && typeof args === 'object' && 'shellId' in args);
  assert.equal(args.shellId, 'session');
});

test('guarded Bash preserves stdin, output, quoting, and failure status', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  const command = 'read -r value; printf "%s|%s\\n" "$value" "spaces and \\"quotes\\""; git commit --allow-empty -F -';
  const run = spawnSync('bash', ['-c', guardedCommand('bash', command, context)], {
    cwd: f.repo, env: f.env, input: `stdin value\n${attributed}`, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /stdin value\|spaces and "quotes"/);
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Model: test-model-one/);
  const failing = guardedCommand('bash', '(exit 23)', context);
  assert.equal(spawnSync('bash', ['-c', failing], { cwd: f.repo, env: f.env }).status, 23);
  const stateful = `${guardedCommand('bash', 'cd ..; retained=yes', context)}\nprintf "%s|%s|%s" "$PWD" "$retained" "\${${contextVariable}+set}"`;
  assert.equal(execFileSync('bash', ['-c', stateful], { cwd: f.repo, env: f.env, encoding: 'utf8' }), `${f.root}|yes|`);
  const restored = `${guardedCommand('bash', 'true', context)}\nprintf "%s" "$${contextVariable}"`;
  assert.equal(execFileSync('bash', ['-c', restored], {
    cwd: f.repo, env: { ...f.env, [contextVariable]: 'previous-context' }, encoding: 'utf8',
  }), 'previous-context');
});

test('separate guarded commands keep their own context across asynchronous worktrees', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', 'Seed');
  ensureInstalled(f.repo);
  const worktree = join(f.root, 'second worktree');
  f.git('worktree', 'add', '-qb', 'parallel', worktree);
  const execute = (cwd: string, sessionId: string) => new Promise<void>((resolveRun, reject) => {
    const command = guardedCommand('bash', `sleep 0.1; git commit --allow-empty -m '${attributed}'`, {
      version: 1, sessionId, model: `model-${sessionId}`,
    });
    const child = spawn('bash', ['-c', command], { cwd, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', code => { if (code === 0) resolveRun(); else reject(new Error(errors)); });
  });
  await Promise.all([execute(f.repo, 'first'), execute(worktree, 'second')]);
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Session-Id: first/);
  const actual = execFileSync('git', ['log', '-1', '--format=%B'], { cwd: worktree, env: f.env, encoding: 'utf8' });
  assert.match(actual, /Copilot-Session-Id: second/);
  assert.doesNotMatch(actual, /model-first/);
});

test('native hook entrypoint returns actionable denial for malformed events', () => {
  const result = spawnSync(process.execPath, [entrypoint, 'pre-tool'], { input: '{"tool_name":"Bash"}', encoding: 'utf8' });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /native Copilot hook event/);
});

test('malformed hook JSON is reported without echoing input', () => {
  const result = spawnSync(process.execPath, [entrypoint, 'pre-tool'], {
    input: '{ "SYNTHETIC_PRIVATE_INPUT": ', encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.permissionDecision, 'deny');
  assert.match(output.permissionDecisionReason, /Invalid JSON/);
  assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_INPUT/);
});

const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
test('PowerShell context creates attributed commits and preserves state and failures', {
  skip: spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).error !== undefined,
}, t => {
  const f = fixture(t);
  ensureInstalled(f.repo);
  const path = join(f.root, 'powershell-message.txt');
  writeFileSync(path, attributed);
  const command = guardedCommand('powershell', `git commit --allow-empty -F '${path.replaceAll("'", "''")}'`, context);
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.git('log', '-1', '--format=%B'), /Copilot-Session-Id: session-one/);
  const failing = guardedCommand('powershell', `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(23)'`, context);
  const failed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `${failing}\nif ($?) { exit 0 } else { exit $LASTEXITCODE }`], {
    cwd: f.repo, env: f.env, encoding: 'utf8',
  });
  assert.equal(failed.status, 23, failed.stderr);
  const stateful = `${guardedCommand('powershell', 'Set-Location ..; $retained = "yes"', context)}\n"$PWD|$retained|$env:${contextVariable}"`;
  const state = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', stateful], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(state.status, 0, state.stderr);
  assert.equal(state.stdout.trim(), `${f.root}|yes|`);
});
