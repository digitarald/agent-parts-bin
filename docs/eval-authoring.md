# Write an eval, step by step

This guide walks through one complete eval for a skill and explains each part.
[Evals](evals.md) covers the rules for every asset type, suites, cost, and
results. `npm run new-plugin` writes a starting eval for each new plugin, so
you usually edit one rather than start from nothing.

## A complete skill eval

The skill lives at `plugins/<plugin>/skills/<skill>/SKILL.md` and its eval at
`evals/<plugin>/eval.yaml`, so the eval loads the skill from
`../../plugins/<plugin>/skills/<skill>`. This example uses a plugin named
`example-plugin` with a skill named `example-skill` that writes `result.json`.
It's a pattern, not an expected answer: replace the task and the outcome
assertions with your skill's real contract.

```yaml
name: example-skill
description: Writes result.json for a realistic request and ignores unrelated questions.
type: capability
defaults:
  executor: copilot-sdk
  model: gpt-5.4-mini
  timeout: 2m
  runs: 1
agent_environment:
  skills:
    - ../../plugins/example-plugin/skills/example-skill
stimuli:
  - name: example-skill-performs-the-task
    prompt: A realistic request that should use the skill.
    tags:
      assets: skill:example-plugin/example-skill
      control: positive
      suite: smoke
    graders:
      - type: completed
      - type: skill-invocation
        config:
          required: [example-skill]
      - type: file-exists
        config:
          path: result.json
      - type: file-matches
        config:
          path: result.json
          pattern: '"status"\s*:\s*"ready"'
  - name: example-skill-ignores-unrelated-question
    prompt: What is the capital of France? Reply with only the city name.
    tags:
      assets: skill:example-plugin/example-skill
      control: negative
    graders:
      - type: completed
      - type: skill-invocation
        config:
          disallowed: [example-skill]
      - type: output-contains
        config:
          substring: Paris
scoring:
  threshold: 1
```

## What each part is for

- `agent_environment.skills` loads the real skill, relative to the eval file.
  Don't paste the skill's instructions into the prompt; that tests the prompt,
  not the skill.
- `tags.assets` names what the case covers, as `skill:<plugin>/<skill>`. The
  coverage check requires every skill to have a positive case, a case in the
  `smoke` suite, and a negative case. [Evals](evals.md#asset-identities) lists
  the identity for every asset type.
- `tags.control` is `positive` for a task the skill should do and `negative`
  for a request it should ignore. `tags.suite: smoke` puts the case in the
  small suite that CI runs.
- Prefix stimulus names with the skill name. Names must be unique across every
  eval in the repository, so saved results map to one case.
- The positive case checks something beyond invocation: here, a parsed output
  file. Other good outcome checks are actual tool arguments or results, or a
  narrowly defined rubric. These graders count as outcome checks: `program`,
  `output-matches`, `output-contains`, `file-matches`, `file-exists`, `prompt`,
  and `panel`. You don't need a custom `program` grader; built-in graders are
  often enough.
- The negative case asserts something observable: the skill wasn't invoked,
  and the answer is still right.

## A skill that answers in chat

A skill that replies in chat, without writing files, uses an output grader
instead of a file grader. This eval passes the coverage check as written:

```yaml
name: release-notes
description: Drafts grouped release notes and ignores unrelated questions.
type: capability
defaults:
  executor: copilot-sdk
  model: gpt-5.4-mini
  timeout: 2m
  runs: 1
agent_environment:
  skills:
    - ../../plugins/release-notes/skills/release-notes
stimuli:
  - name: release-notes-groups-changes
    prompt: "Draft release notes for: added CSV export, fixed login timeout."
    tags:
      assets: skill:release-notes/release-notes
      control: positive
      suite: smoke
    graders:
      - type: skill-invocation
        config:
          required: [release-notes]
      - type: output-matches
        config:
          pattern: '[Ff]ixed[\s\S]*login timeout'
  - name: release-notes-ignores-arithmetic
    prompt: What is two plus two? Reply with only the digit.
    tags:
      assets: skill:release-notes/release-notes
      control: negative
    graders:
      - type: skill-invocation
        config:
          disallowed: [release-notes]
      - type: output-contains
        config:
          substring: "4"
scoring:
  threshold: 1
```

## Data and answer keys

Use synthetic fixtures. Keep answer keys and grader programs in
`grading_environment`, not in the skill or anywhere the agent can read.

## Check it, then run it

```sh
npm run verify                                   # free: coverage, strict lint, tests
npm run eval:list -- --plugin example-plugin     # free: what a run would select
node scripts/evals.mjs eval --plugin example-plugin   # costs AI credits
npm run eval:report -- --plugin example-plugin
```

`npm run verify` and `npm run eval:list` don't call a model. The eval command
runs real Copilot sessions. Valid failed verdicts are reported; add
`--require-pass` to make them fail the command too. Errors always fail.

References: [eval schema](https://microsoft.github.io/vally/reference/eval-spec/),
[grader catalog](https://microsoft.github.io/vally/reference/graders/), and
[CI guidance](https://microsoft.github.io/vally/get-started/add-to-ci/).
