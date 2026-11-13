import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const contextVariable = 'COPILOT_COMMIT_ATTRIBUTION';
export const coauthor = 'Copilot <223556219+Copilot@users.noreply.github.com>';

/** @param {unknown} value */
export function parseContext(value) {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
    || !('sessionId' in value) || !validIdentifier(value.sessionId)
    || ('model' in value && !validIdentifier(value.model))) {
    throw new Error('Invalid Copilot attribution context. Fix the plugin integration and retry; do not bypass the hook.');
  }
  return { version: 1, sessionId: value.sessionId, ...('model' in value ? { model: value.model } : {}) };
}

/** @param {unknown} value */
function validIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}

/** @param {string} cwd @param {string[]} args @param {string} input */
function trailers(cwd, args, input) {
  return execFileSync('git', ['-c', 'trailer.separators=:', 'interpret-trailers', '--no-divider', ...args], {
    cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** @param {string} cwd @param {string} message */
function parseTrailers(cwd, message) {
  return trailers(cwd, ['--parse'], message).trim().split('\n').filter(Boolean).map(line => {
    const separator = line.indexOf(':');
    return { key: line.slice(0, separator).toLowerCase(), value: line.slice(separator + 1).trim() };
  });
}

/** @param {string} messagePath @param {string} cwd */
export function checkMessage(messagePath, cwd = process.cwd()) {
  const rawContext = process.env[contextVariable];
  if (rawContext === undefined) return;
  const context = parseContext(JSON.parse(rawContext));
  const message = readFileSync(messagePath, 'utf8');
  const parsed = parseTrailers(cwd, message);
  if (!parsed.some(trailer => trailer.key === 'co-authored-by' && trailer.value === coauthor)) {
    throw new Error(`Missing attribution. Retry using the commit skill and include a final trailer:\nCo-authored-by: ${coauthor}`);
  }
  const sessions = parsed.filter(trailer => trailer.key === 'copilot-session-id');
  const models = parsed.filter(trailer => trailer.key === 'copilot-model');
  if ([...sessions, ...models].some(trailer => !validIdentifier(trailer.value))) {
    throw new Error('Malformed Copilot session/model trailer. Correct the attribution and retry.');
  }
  if (sessions.length > 0) return;
  if (models.length > 0) {
    throw new Error('Copilot-Model has no Copilot-Session-Id. Restore the recorded session attribution and retry.');
  }
  const args = ['--if-exists', 'doNothing', '--trailer', `Copilot-Session-Id: ${context.sessionId}`];
  if (context.model) args.push('--trailer', `Copilot-Model: ${context.model}`);
  const updated = trailers(cwd, args, message);
  const recorded = parseTrailers(cwd, updated);
  if (!recorded.some(trailer => trailer.key === 'copilot-session-id' && trailer.value === context.sessionId)) {
    throw new Error('Git did not produce the required session trailer. Check repository trailer configuration and retry.');
  }
  writeFileSync(messagePath, updated);
  if (!context.model) {
    process.stderr.write('commit-attribution: Issuing model unavailable; Copilot co-author and runtime session ID recorded.\n');
  }
}
