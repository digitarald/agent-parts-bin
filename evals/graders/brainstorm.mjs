import { calls, check, isMain, normalize, payload, runGrade } from "./common.mjs";

const canvasId = "marketplace-starter-brainstorm";
const seedText = "Keep onboarding simple";

function lastReply(trajectory, turn) {
  return trajectory.events.filter((event) => event.type === "assistant_message" && (event.turn ?? 0) === turn)
    .map((event) => event.data?.content).filter((text) => typeof text === "string" && text.trim()).at(-1) ?? "";
}

export function assessCollaboration(trajectory) {
  const capabilities = calls(trajectory, "list_canvas_capabilities").find((call) => call.success);
  const opened = calls(trajectory, "open_canvas").filter((call) => call.success);
  const actions = calls(trajectory, "invoke_canvas_action").filter((call) => call.success)
    .map((call) => ({ ...call, value: payload(call) }));
  const reads = actions.filter((call) => call.args?.actionName === "get_board");
  const first = reads[0];
  const firstWrite = actions.find((call) => ["save_note", "remove_note"].includes(call.args?.actionName));
  const seed = first?.value?.board?.notes?.find((note) => note.text === seedText);
  const afterFirstTurn = actions.filter((call) => (call.event.turn ?? 0) === 0).at(-1)?.value?.board;
  const final = reads.at(-1)?.value?.board;
  const firstIdeas = afterFirstTurn?.notes?.filter((note) => note.id !== seed?.id) ?? [];
  const finalSeed = final?.notes?.find((note) => note.id === seed?.id);
  const reply = lastReply(trajectory, 0);
  return [
    check("Must discover the real headless SDK contract.", payload(capabilities)?.canvasId === canvasId
      && payload(capabilities)?.transport === "headless-sdk-contract"),
    check("Must open one stable instance handle.", opened.length > 0
      && new Set(opened.map((call) => call.args?.instanceId)).size === 1
      && opened.every((call) => payload(call)?.headless === true)),
    check("Must read the existing board before changing it.", first && firstWrite
      && trajectory.events.indexOf(first.event) < trajectory.events.indexOf(firstWrite.event)),
    check("Must preserve the seeded note and add exactly two ideas before the user responds.",
      seed && afterFirstTurn?.notes?.length === 3 && firstIdeas.length === 2
      && firstIdeas.every((note) => note.column === "ideas" && note.text.trim())
      && afterFirstTurn.notes.some((note) => note.id === seed.id && note.text === seedText)),
    check("Must ask one focused question without claiming native UI presentation.",
      (reply.match(/\?/g) ?? []).length === 1
      && !/(?:native|VS Code|Copilot App) (?:window|UI) (?:is )?(?:open|visible)/i.test(reply)),
    check("Must move the original note by its existing ID, preserving text and the other notes.",
      finalSeed?.text === seedText && finalSeed?.column === "next" && final?.notes?.length === 3
      && firstIdeas.every((note) => final.notes.some((candidate) => candidate.id === note.id
        && candidate.text === note.text && candidate.column === note.column))),
    check("Must not delete notes or replace the board.", actions.every((call) => call.args?.actionName !== "remove_note")),
    check("Must finish with an actual board read in the second turn.", (reads.at(-1)?.event.turn ?? 0) === 1),
  ];
}

export function assessFallback(trajectory) {
  const text = normalize(trajectory.output).replaceAll("\u2019", "'");
  const bullets = text.match(/^\s*(?:[-*]|\d+\.)\s+.+$/gm) ?? [];
  const unavailable = /(?:can't|cannot|couldn't)\s+(?:present|open|show|display|render|use|access)\b[^.!?\n]{0,100}\b(?:board|canvas)\b|\b(?:board|canvas)\b[^.!?\n]{0,100}\b(?:unavailable|not available|not supported|not exposed|isn't available|aren't available)\b|(?:don't have|do not have|doesn't expose|does not expose|without|no)\b[^.!?\n]{0,100}\b(?:board|canvas)\b/i.test(text);
  return [
    check("Must explain that the board/canvas is unavailable in this host.", unavailable),
    check("Must continue with two chat ideas.", (bullets.length === 2 || (bullets.length === 3 && bullets.at(-1).includes("?")))
      && text.split(/\s+/).length <= 180),
    check("Must ask one focused follow-up question.", (text.match(/\?/g) ?? []).length === 1),
    check("Must not claim a board was opened or updated.",
      !/\b(?:opened|created|updated)\s+(?:the|a|your)\s+(?:canvas|board)\b/i.test(text)),
  ];
}

if (isMain(import.meta.url)) {
  await runGrade("brainstorm-contract", (trajectory) => {
    if (process.argv[2] === "board") return assessCollaboration(trajectory);
    if (process.argv[2] === "fallback") return assessFallback(trajectory);
    throw new Error("Use the board or fallback brainstorm scenario.");
  });
}
