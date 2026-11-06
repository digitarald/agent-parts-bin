import test from "node:test";
import assert from "node:assert/strict";
import { score } from "../evals/graders/common.mjs";

test("shared grader scoring refuses an empty list of assertions", () => {
  assert.throws(() => score("empty", []), /assertions/);
});
