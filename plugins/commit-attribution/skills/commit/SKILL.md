---
name: commit
description: "Create a Git commit with Copilot attribution. Use when: committing changes, writing a commit message, or retrying a commit rejected for missing attribution."
---

# Commit with attribution

1. Inspect the working tree and staged diff. Follow repository commit conventions, stage only intended changes, and never include secrets.
2. Include this trailer in the final trailer block, separated from the message body by a blank line:

   ```text
   Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
   ```

3. Use a normal `git commit`. The installed Git hook supplies missing `Copilot-Session-Id` and verified `Copilot-Model` metadata. Do not invent identifiers or replace valid historical attribution.
4. If the hook rejects the commit, read its error, correct the missing attribution, and retry. If installation or runtime context is broken, report the blocker instead of claiming success.
5. Verify the resulting commit and its actual trailers with `git log -1 --format=%B`. Do not push or amend existing history unless requested.

Never bypass the guard using `--no-verify`, hook-path overrides, disabling or editing hooks, removing attribution context, or Git plumbing. Attribution failures are instructions to fix the message, not permission to evade enforcement.
