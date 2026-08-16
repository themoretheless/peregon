import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_GUTTER_LINES,
  MAX_HIGHLIGHT_SOURCE_LENGTH,
  MAX_HIGHLIGHT_TOKENS,
  canBuildSyntaxSnapshot,
  countLines,
  dominantEol,
  exceedsHighlightTokenLimit,
  gutterText,
  withEditorEol,
} from "../src/components/json-code-editor-policy.ts";
import { computeTextChange } from "@peregon/syntax-engine";

test("editor preserves the dominant model EOL across textarea LF normalization", () => {
  assert.equal(dominantEol("a\r\nb\r\nc\nd"), "\r\n");
  assert.equal(dominantEol("a\nb\r\nc"), "\n");
  assert.equal(dominantEol("single line", "\r\n"), "\r\n");

  const before = "a\r\nb\r\nc😀";
  const textareaAfterTyping = "a\nb\nc😀!";
  const emitted = withEditorEol(textareaAfterTyping, dominantEol(before));
  assert.equal(emitted, "a\r\nb\r\nc😀!");
  assert.deepEqual(computeTextChange(before, emitted), {
    from: before.length,
    to: before.length,
    insert: "!",
  });
});

test("editor normalizes mixed textarea newlines to an explicit convention", () => {
  assert.equal(withEditorEol("a\r\nb\rc\nd", "\n"), "a\nb\nc\nd");
  assert.equal(withEditorEol("a\r\nb\rc\nd", "\r"), "a\rb\rc\rd");
  assert.equal(withEditorEol("ключ😀\nvalue", "\r\n"), "ключ😀\r\nvalue");
});

test("line counting matches split without allocating the lines", () => {
  for (const value of ["", "one", "a\nb", "a\nb\n", "\n", "ключ😀\nvalue\r\nzz"]) {
    assert.equal(countLines(value), value.split("\n").length, JSON.stringify(value));
  }
});

test("the gutter numbers every line as one text node and gives up past the bound", () => {
  assert.equal(gutterText(1), "1");
  assert.equal(gutterText(3), "1\n2\n3");

  // Numbering must stay aligned with an element-per-line gutter: same count,
  // same order, one node instead of N.
  const preview = gutterText(1935);
  assert.equal(preview.split("\n").length, 1935);
  assert.equal(preview.split("\n").at(-1), "1935");

  assert.equal(gutterText(MAX_GUTTER_LINES, MAX_GUTTER_LINES).split("\n").length, MAX_GUTTER_LINES);
  assert.equal(gutterText(MAX_GUTTER_LINES + 1, MAX_GUTTER_LINES), "");
  assert.equal(gutterText(5, 4), "");
});

test("an unbounded preview keeps its full text while the gutter stays one node", () => {
  const rows = Array.from({ length: 250_000 }, (_, index) => `019f80c2957f75ad982e${index}`);
  const preview = rows.join("\n");

  assert.equal(countLines(preview), 250_000);
  // Past the bound the numbering is dropped rather than materialized, but the
  // preview itself is never truncated — "Копировать всё" still yields all rows.
  assert.equal(gutterText(countLines(preview)), "");
  assert.equal(preview.split("\n").at(-1), rows.at(-1));
});

test("large or token-dense editor values bypass span-based highlighting", () => {
  assert.equal(canBuildSyntaxSnapshot("x".repeat(MAX_HIGHLIGHT_SOURCE_LENGTH), true), true);
  assert.equal(canBuildSyntaxSnapshot("x".repeat(MAX_HIGHLIGHT_SOURCE_LENGTH + 1), true), false);
  assert.equal(canBuildSyntaxSnapshot("small", false), false);

  const atLimit = [{ tokens: new Array(MAX_HIGHLIGHT_TOKENS) }];
  const overLimit = [{ tokens: new Array(MAX_HIGHLIGHT_TOKENS + 1) }];
  assert.equal(exceedsHighlightTokenLimit(atLimit), false);
  assert.equal(exceedsHighlightTokenLimit(overLimit), true);

  const largeValue = `[${"0,".repeat(512 * 1024)}0]`;
  assert.equal(canBuildSyntaxSnapshot(largeValue, true), false);
  assert.equal(withEditorEol(largeValue, "\n"), largeValue);
});
