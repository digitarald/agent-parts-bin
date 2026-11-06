import baseTest from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { parse } from 'yaml';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { evalParams, root as projectRoot, vallyCliPath } from '../scripts/evals.mjs';
import { missing } from '../scripts/examples.mjs';
import { checkCoverage } from '../scripts/validate-evals.mjs';

// Example-only tests: skip every test here when the example's files are gone.
const skip = missing('evals/graders/dist/authoring.mjs');
const test = skip ? (name) => baseTest(name, { skip }) : baseTest;
const { gradeAuthoring } = skip ? {} : await import('../evals/graders/dist/authoring.mjs');

test('the actual relocated grader rejects missing, misplaced, malformed, and invocation-only artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'marketplace grader test '));
  try {
    assert.equal((await gradeAuthoring(dir)).passed, false);
    await mkdir(join(dir, 'skill-authoring/skills/change-summary'), { recursive: true });
    await mkdir(join(dir, 'skill-authoring/evals/change-summary'), { recursive: true });
    await writeFile(join(dir, 'skill-authoring/skills/change-summary/SKILL.md'),
      '---\nname: change-summary\ndescription: Summarize changes.\n---\nRead changes.txt and write summary.json.');
    await writeFile(join(dir, 'skill-authoring/evals/change-summary/eval.yaml'), 'name: change-summary\nstimuli: []\n');
    assert.match((await gradeAuthoring(dir)).evidence, /Required generated skill or eval file is missing/);
    await mkdir(join(dir, 'skills/change-summary'), { recursive: true });
    await mkdir(join(dir, 'evals/change-summary'), { recursive: true });
    const skill = join(dir, 'skills/change-summary/SKILL.md');
    const spec = join(dir, 'evals/change-summary/eval.yaml');
    await writeFile(skill, 'not frontmatter');
    await writeFile(spec, 'name: sample');
    assert.equal((await gradeAuthoring(dir)).passed, false);
    await writeFile(skill, '---\nname: change-summary\ndescription: Summarize changes.\n---\nRead changes.txt and write summary.json.');
    await writeFile(spec, `name: generated-test
agent_environment:
  skills: [../../skills/change-summary]
stimuli:
  - name: task-case
    prompt: Summarize changes.txt.
    graders:
      - type: skill-invocation
        config:
          required: [change-summary]
  - name: non-trigger
    prompt: What is the capital of France?
    graders:
      - type: skill-invocation
        config:
          disallowed: [change-summary]
`);
    assert.match((await gradeAuthoring(dir)).evidence, /outcome assertions/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the distributed grader uses the pinned validator without PATH and reports missing infrastructure as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'marketplace grader environment '));
  try {
    await mkdir(join(dir, 'skills/change-summary'), { recursive: true });
    await mkdir(join(dir, 'evals/change-summary'), { recursive: true });
    await writeFile(join(dir, 'skills/change-summary/SKILL.md'),
      '---\nname: change-summary\ndescription: Summarize nonempty changelog lines into a JSON file.\n---\nRead changes.txt and write summary.json with count and changes fields.');
    await writeFile(join(dir, 'evals/change-summary/eval.yaml'), `name: change-summary
agent_environment:
  skills: [../../skills/change-summary]
stimuli:
  - name: task-case
    prompt: Summarize changes.txt into summary.json.
    graders:
      - type: skill-invocation
        config:
          required: [change-summary]
      - type: file-exists
        config:
          path: summary.json
  - name: non-trigger
    prompt: What is the capital of France?
    graders:
      - type: skill-invocation
        config:
          disallowed: [change-summary]
scoring:
  threshold: 1
`);
    const env = { ...process.env, EVALUATE_WORKSPACE: dir };
    delete env.MARKETPLACE_VALLY_CLI;
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = '';
    const run = (...args) => spawnSync(process.execPath, [join(projectRoot, 'evals/graders/dist/authoring.mjs'), ...args], {
      env, cwd: dir, encoding: 'utf8', timeout: 60000
    });
    const valid = run(evalParams.MARKETPLACE_VALLY_CLI);
    assert.equal(evalParams.MARKETPLACE_VALLY_CLI, vallyCliPath);
    assert.ifError(valid.error);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    assert.equal(JSON.parse(valid.stdout).passed, true);
    const missing = run();
    assert.equal(missing.status, 1);
    const result = JSON.parse(missing.stdout);
    assert.equal(result.status, 'error');
    assert.match(result.evidence, /MARKETPLACE_VALLY_CLI/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const reference = join(projectRoot, 'plugins/customization-authoring/skills/skill-authoring/references/evals.md');
test('the authoring reference example meets the coverage rules, and its regexes accept correct output and reject wrong output', { skip: !existsSync(reference) }, async () => {
  const text = await readFile(reference, 'utf8');
  const block = text.match(/```yaml\r?\n([\s\S]*?)```/)?.[1];
  assert.ok(block, 'the reference keeps a YAML example');
  const spec = parse(block);
  // Placed where a marketplace keeps it, the example passes the same coverage check as npm run verify.
  const asset = { id: 'skill:example-plugin/example-skill', kind: 'skill', name: 'example-skill',
    path: resolve(projectRoot, 'plugins/example-plugin/skills/example-skill') };
  assert.equal(checkCoverage([asset], [{ path: resolve(projectRoot, 'evals/example-plugin/eval.yaml'), spec }]), 2);
  assert.ok(spec.stimuli.every((stimulus) => stimulus.name.startsWith('example-skill-')), 'stimulus names carry the skill name');
  const graders = spec.stimuli.flatMap((stimulus) => stimulus.graders ?? []);
  const patterns = graders.filter((grader) => grader.type === 'file-matches').map((grader) => new RegExp(grader.config.pattern));
  assert.ok(patterns.length);
  for (const pattern of patterns) {
    for (const good of ['{"status":"ready"}', '{ "status" : "ready" }', '{\n  "status": "ready"\n}']) assert.ok(pattern.test(good), `${pattern} should match ${good}`);
    for (const bad of ['{"status":"draft"}', '{"state":"ready"}']) assert.ok(!pattern.test(bad), `${pattern} should reject ${bad}`);
  }
});
