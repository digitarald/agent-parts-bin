---
name: skill-authoring
description: Create or improve an agent skill with clear triggers, bounded instructions, and positive and negative Vally evals. Use for requests to author a reusable SKILL.md and its evaluations. Don't use for ordinary coding, factual questions, or simply running an existing skill.
---

# Author a skill and its evals

Turn a concrete, repeatable task into a small skill whose behavior can be checked.

1. Identify the task, inputs, expected output, trigger examples, non-trigger examples, and allowed side effects. Ask only for information that materially changes the result and isn't already supplied.
2. Determine the active workspace root from the session's working directory or a working-directory query. Resolve the user's relative output paths against that root, not against this skill's directory. The directory containing this SKILL.md and its references is installation content, not the output workspace; don't create generated skills or evals under it unless the user explicitly asks to modify this skill. In a marketplace, put the new skill under the workflow plugin that owns it and keep evals outside that plugin. Don't create an unrelated agent, marketplace, or framework.
3. Write `SKILL.md` with YAML frontmatter containing a lowercase kebab-case `name` matching its directory and a specific `description`. Explain when to use and not use it. Give executable instructions, input/error handling, and an observable outcome.
4. Add a Vally eval using [the authoring reference](references/evals.md). Include a real task case with outcome graders and an unrelated request with a disallowed skill-invocation grader and an observable answer check. Tag each case with the assets it covers and its control, put one positive case in the smoke suite, and prefix stimulus names with the skill name. Resolve the skill path relative to the eval file.
5. Verify the files exist at the requested workspace-relative paths, not just beneath the installed skill directory. Check their structure, real relative paths, and assertions that distinguish correct from incorrect behavior. Don't claim a behavioral pass unless the eval actually ran. Don't install dependencies or run paid evals unless requested.

Write only the requested skill and eval artifacts. Don't read credential files, modify existing work without approval, or embed tokens, private endpoints, expected answers, or this authoring skill's own evaluation data in the generated skill.

Finish with the created paths and the command to validate/run the eval. Distinguish static inspection from an executed behavioral result.
