# A small Vally eval

Use the project's pinned Vally release and its supported schema. The following is a pattern, not an expected answer: replace its task and outcome assertions with the new skill's actual contract.

In a marketplace built from the plugin marketplace starter, the skill lives at `plugins/<plugin>/skills/<skill>/SKILL.md` and its eval at `evals/<plugin>/eval.yaml`, so the eval loads the skill from `../../plugins/<plugin>/skills/<skill>`. Outside a marketplace, resolve the skill path the same way: relative to the eval file. The example uses a plugin named `example-plugin` with a skill named `example-skill`.

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

What each part is for:

- `tags.assets` names what the case covers, as `skill:<plugin>/<skill>`. A marketplace's coverage check requires every skill to have a positive case, a case in the `smoke` suite, and a negative case.
- `tags.control` is `positive` for a task the skill should do and `negative` for a request it should ignore. `tags.suite: smoke` puts the case in the small suite that CI runs.
- Prefix stimulus names with the skill name. Names must be unique across every eval in the repository, so two copies of this pattern don't collide.
- The task case must check something beyond invocation, such as a parsed output file, actual tool arguments/results, or a narrowly defined rubric. Graders that count as outcome checks: `program`, `output-matches`, `output-contains`, `file-matches`, `file-exists`, `prompt`, and `panel`. You don't need a custom `program` grader; the built-in graders are often enough.
- The negative case asserts something observable: the skill wasn't invoked, and the answer is still right.

Use synthetic fixtures. Keep answer keys in grader-only inputs, not in the skill.

`vally lint --eval-spec <path> --strict` checks the spec without an agent. In a marketplace, `npm run verify` also runs the coverage check. `vally eval --eval-spec <path>` runs a real agent and costs inference credits. By default, valid failing verdicts are reported; `--require-pass` makes those verdicts fail the command too. Operational errors always fail.

References: [eval schema](https://microsoft.github.io/vally/reference/eval-spec/), [grader catalog](https://microsoft.github.io/vally/reference/graders/), [CI guidance](https://microsoft.github.io/vally/get-started/add-to-ci/).
