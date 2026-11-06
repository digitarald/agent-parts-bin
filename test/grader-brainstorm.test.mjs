import test from "node:test";
import assert from "node:assert/strict";
import { missing } from "../scripts/examples.mjs";

const skip = missing("evals/graders/brainstorm.mjs");
const { assessCollaboration, assessFallback } = skip ? {} : await import("../evals/graders/brainstorm.mjs");
const passes = (checks) => checks.every((item) => item.passed);
const trajectory = (output = "", events = []) => ({ output, events });

let nextId = 0;
function tool(name, args, value, turn = 0, success = true) {
  const toolCallId = `call-${nextId++}`;
  return [
    { type: "tool_call", turn, data: { toolName: name, toolCallId, arguments: args } },
    { type: "tool_result", turn, data: { toolName: name, toolCallId, success, result: typeof value === "string"
      ? { content: value } : { structuredContent: value, content: JSON.stringify(value) } } },
  ];
}

function boardRun() {
  const id = "marketplace-starter-brainstorm";
  const seed = { id: "seed", text: "Keep onboarding simple", column: "ideas" };
  const one = { id: "one", text: "Write a short checklist", column: "ideas" };
  const two = { id: "two", text: "Pair with a buddy", column: "ideas" };
  const invoke = (actionName, notes, turn = 0) => tool("brainstorm-host-invoke_canvas_action",
    { instanceId: "onboarding", actionName }, { canvasId: id, instanceId: "onboarding", actionName, board: { notes } }, turn);
  return trajectory("Moved the original note.", [
    ...tool("brainstorm-host-list_canvas_capabilities", { canvasId: id }, { canvasId: id, transport: "headless-sdk-contract" }),
    ...tool("brainstorm-host-open_canvas", { canvasId: id, instanceId: "onboarding" }, { canvasId: id, headless: true }),
    ...invoke("get_board", [seed]),
    ...invoke("save_note", [seed, one]),
    ...invoke("save_note", [seed, one, two]),
    ...invoke("get_board", [seed, one, two]),
    { type: "assistant_message", turn: 0, data: { content: "Two ideas added. Which should we prioritize?" } },
    ...invoke("save_note", [{ ...seed, column: "next" }, one, two], 1),
    ...invoke("get_board", [{ ...seed, column: "next" }, one, two], 1),
  ]);
}

test("canvas grader verifies real state and rejects lost IDs, excessive notes, and writes before reads", { skip }, () => {
  const good = boardRun();
  assert.ok(passes(assessCollaboration(good)));
  const lost = structuredClone(good);
  lost.events.at(-1).data.result.structuredContent.board.notes[0].id = "replacement";
  assert.ok(!passes(assessCollaboration(lost)));
  const early = structuredClone(good);
  early.events.splice(4, 2);
  assert.ok(!passes(assessCollaboration(early)));
  const noQuestion = structuredClone(good);
  noQuestion.events.find((event) => event.type === "assistant_message").data.content = "Here is the complete plan.";
  assert.ok(!passes(assessCollaboration(noQuestion)));
});

test("fallback accepts natural punctuation but rejects fabricated UI or an oversized plan", { skip }, () => {
  const text = "I can\u2019t present the shared board on this host, so we can brainstorm in chat.\n\n- Write a checklist.\n- Pair with a buddy.\n\nWhat should we prioritize?";
  assert.ok(passes(assessFallback(trajectory(text))));
  assert.ok(passes(assessFallback(trajectory(text.replace("can\u2019t", "couldn\u2019t")))));
  assert.ok(!passes(assessFallback(trajectory(text.replace("I can\u2019t present the shared board on this host", "The shared board is ready but I can't write files")))));
  assert.ok(!passes(assessFallback(trajectory("I opened the board.\n- One idea.\n- Another idea.\nWhat next?"))));
  assert.ok(!passes(assessFallback(trajectory(text.replace("- Pair with a buddy.", "- Pair with a buddy.\n- Add another plan.\n- Add more tasks.")))));
});
