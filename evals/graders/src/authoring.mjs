import { readFile, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';

function verdict(issues) {
  return {
    name: 'generated-skill-contract',
    kind: 'code',
    passed: issues.length === 0,
    score: issues.length ? 0 : 1,
    evidence: issues.length ? issues.join('; ') : 'Generated skill and positive/negative evals satisfy the requested contract and strict Vally lint.'
  };
}

export async function gradeAuthoring(workspace, validator) {
  const issues = [];
  const skillPath = resolve(workspace, 'skills/change-summary/SKILL.md');
  const evalPath = resolve(workspace, 'evals/change-summary/eval.yaml');
  let skillText;
  let evalText;
  try {
    skillText = await readFile(skillPath, 'utf8');
    evalText = await readFile(evalPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return verdict(['Required generated skill or eval file is missing']);
    throw error;
  }
  const header = skillText.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!header) return verdict(['Generated SKILL.md has no valid frontmatter envelope']);
  const skillDoc = parseDocument(header[1], { uniqueKeys: true });
  const evalDoc = parseDocument(evalText, { uniqueKeys: true });
  if (skillDoc.errors.length || evalDoc.errors.length) return verdict(['Generated YAML is invalid']);
  const skill = skillDoc.toJS();
  const spec = evalDoc.toJS();
  if (skill?.name !== 'change-summary' || typeof skill.description !== 'string' || !skill.description.trim()) issues.push('Skill identity or description is invalid');
  if (!skillText.includes('summary.json') || !skillText.includes('changes.txt')) issues.push('Skill omits the required input/output contract');
  if (!Array.isArray(spec?.stimuli) || spec.stimuli.length < 2) return verdict([...issues, 'Need task and non-trigger stimuli']);
  const graders = stimulus => Array.isArray(stimulus.graders) ? stimulus.graders : [];
  const hasTask = spec.stimuli.some(stimulus =>
    graders(stimulus).some(grader => grader.type === 'skill-invocation' && grader.config?.required?.includes('change-summary')) &&
    graders(stimulus).some(grader => /^(file-.+|output-.+|program|prompt|panel)$/.test(grader.type)));
  const hasNegative = spec.stimuli.some(stimulus =>
    graders(stimulus).some(grader => grader.type === 'skill-invocation' && grader.config?.disallowed?.includes('change-summary')));
  if (!hasTask) issues.push('Task case lacks skill invocation and outcome assertions');
  if (!hasNegative) issues.push('Missing non-trigger case');
  const skillPaths = spec.agent_environment?.skills ?? [];
  if (!Array.isArray(skillPaths) || !skillPaths.some(path => typeof path === 'string' &&
      resolve(dirname(evalPath), path) === dirname(skillPath))) issues.push('Eval does not load the generated skill');
  if (!issues.length) {
    if (!validator || !isAbsolute(validator)) throw new Error('Pass the pinned Vally CLI as the first argument; the eval supplies it from the MARKETPLACE_VALLY_CLI param.');
    await access(validator);
    const lint = spawnSync(process.execPath,
      [validator, 'lint', 'skills', '--eval-spec', 'evals/change-summary/eval.yaml', '--strict'], {
        cwd: workspace, encoding: 'utf8',
        env: { ...process.env, VALLY_TELEMETRY_OPTOUT: '1' }, timeout: 30000
      });
    if (lint.error) throw new Error(`Unable to run the pinned Vally validator: ${lint.error.message}`);
    if (lint.status !== 0) issues.push(`Generated files fail strict Vally lint: ${(lint.stdout + lint.stderr).slice(-1500)}`);
  }
  return verdict(issues);
}

// Compare real paths: Node resolves import.meta.url through symlinks but not argv.
const realOrResolved = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
if (process.argv[1] && realOrResolved(resolve(process.argv[1])) === realOrResolved(fileURLToPath(import.meta.url))) {
  try {
    if (!process.env.EVALUATE_WORKSPACE) throw new Error('EVALUATE_WORKSPACE is required');
    console.log(JSON.stringify(await gradeAuthoring(process.env.EVALUATE_WORKSPACE, process.argv[2])));
  } catch (error) {
    console.log(JSON.stringify({
      name: 'generated-skill-contract', kind: 'code', status: 'error',
      passed: false, score: 0,
      evidence: `Grader infrastructure failed: ${error instanceof Error ? error.message : String(error)}`
    }));
    process.exitCode = 1;
  }
}
