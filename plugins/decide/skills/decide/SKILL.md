---
name: decide
description: "Use when repeated classification, routing, filtering, prioritization, or grading would otherwise require the main agent to reason through every item or workflow step. Reserve expensive reasoning for uncertain or exceptional cases."
---

# Decide

Use the [CLI](./scripts/decide.py) as a specialist judge for bounded decisions, not a draft answer to improve. Do not assume your own intuition is more reliable: re-labeling accepted results spends paid main-model tokens on another LLM opinion, not a correctness check.

Python 3.10+, no packages. Returns typed decisions and probabilities, not explanations.

This is an experimental plugin, not an evaluated decision policy. Live calls
send the supplied state and questions to the user's configured Microsoft
Foundry resource and may incur charges. Use only data approved for that
destination. Never send secrets or private data without explicit authorization.

## Design once, run programmatically

- Use deterministic checks where rules suffice. For remaining judgments, define reusable criteria rather than authoring individual answers.
- Validate the policy against known outcomes for the intended workload. Before calling, set acceptance checks, probability cutoffs, and escalation conditions based on the cost of errors. Selected-label probability is not measured accuracy.
- Let the caller check task invariants and related-answer consistency. Escalate contradictions, unknowns, failures, and cases outside the validated scope regardless of probability; never turn a failed call into a negative answer.
- Within that scope, an accepted result is the decision: consume it and continue, without independently relabeling it for reassurance. Reopen it for a defined escalation trigger, new evidence, or a planned audit, not as a routine second pass.
- Batch independent questions sharing one state. Chain dependent stages in the caller; use bounded parallelism across states when quota permits.
- Reuse unchanged decisions and carry only relevant evidence forward. Save per-item results outside the agent context.
- Review exceptions and audit findings. If errors recur, revise and revalidate the shared policy instead of repeatedly repairing individual answers.

Judge savings by main-agent turns/tokens avoided at acceptable quality, including caller setup, decision calls, latency, and escalations. Decisions select work; they do not grant permissions.

## Invoke

Resolve the script and assets relative to the directory containing this
`SKILL.md`, not a user-level installation or the caller's working directory.
Replace the example path below with that absolute directory.
Agents always pass `--non-interactive`.

```bash
DECIDE="/absolute/path/to/this/skill/scripts/decide.py"

# Prefer a named batch for multiple judgments over one state.
python3 "$DECIDE" batch --non-interactive \
  --input "$(dirname "$DECIDE")/../assets/triage.json"
```

Batch input contains `state` and named `questions`; see [the example](./assets/triage.json) or `schema`. It combines questions, not records; the caller iterates or schedules records.

Single-question commands: `noul` (`bool` alias), `choice`, `score`. Use `<command> --help` for flags. Text input: `--state-file PATH` or `--state-file -`. Batch JSON input: `--input PATH` or `--input -`.

## Consume and branch

Default JSON is a named-value map. Batch results use the request's question names; single-question commands use `decision`.

| Answer type | Default result |
| --- | --- |
| `noul` (`bool` is a command alias) | Boolean from P(true) >= `--threshold` (default 0.5). |
| `choice` | `{"value":"label","probability":0.99}` with the selected label's probability. |
| `score` | Weighted level index, 0 to N-1, not a percentage. Levels run lowest to highest. |

Branch on `result[name]` for booleans/scores, or `result[name].value` and `.probability` for choices. `--threshold` applies only to booleans; choose choice-probability cutoffs in the caller. Numeric precision is preserved.

`--value` emits a single scalar without choice probability. `--full` preserves the v1 envelope (`answers[name]`) with distributions, provider confidence, legends, usage, and timing. Provider confidence is distinct from selected-label probability.

Offline fixtures: [compact](./assets/triage-response.json), [full](./assets/triage-response-full.json). Contract v2 uses the compact default; v1 callers should add `--full`. `schema` describes all output formats and errors.

Exit 0 means the call succeeded, not that the answer is true:

```bash
outage=$(python3 "$DECIDE" bool --non-interactive --value \
  --question "Does this report an outage?" --state "Checkout is down.") || exit $?
if [ "$outage" = true ]; then
  printf '%s\n' "Investigate the outage"
else
  printf '%s\n' "Continue normal triage"
fi
```

Errors use `{"schema_version":1,"error":{"exit_code":...,"message":...,"retryable":...}}` on stderr, with empty stdout. Codes: `2` invalid input, `3` setup/authentication, `4` transient failure, `5` response/service failure, `130` cancelled.

Validation precedes network access. At most one API attempt, no internal retries. Retry only when `error.retryable`, with bounded backoff and attention to `error.retry_after_seconds`; another attempt may incur another charge.

`--dry-run` validates and prints the request, including its state, without a network call or simulated response. `schema` supplies limits and the wire contract.

If `error.setup_required: true`, have the user run `python3 <skill-path>/scripts/decide.py setup` in their terminal. Never collect keys in chat. Load [setup and authentication](./references/setup.md) only for configuration or access issues.
