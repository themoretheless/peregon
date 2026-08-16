import assert from "node:assert/strict";
import test from "node:test";

import { listPreviewContent, previewContent } from "../src/runtime/preview-content.ts";

const result = (preview) => ({
  ok: true,
  cached: false,
  preview,
  preview_truncated: false,
  schema: null,
  input_schema: null,
  output_schema: null,
  stats: {
    input_items: preview.length,
    output_items: preview.length,
    filtered_out: 0,
    skipped_items: 0,
  },
  diagnostics: [],
});

test("a full preview reaches the viewer with every row intact", () => {
  const rows = Array.from({ length: 1935 }, (_, index) => ({ id: `019f80c2957f75ad982e${index}` }));

  const records = previewContent(result(rows));
  assert.deepEqual(JSON.parse(records), rows);
  assert.equal(records.split("\n").at(0), "[");

  const values = listPreviewContent(result(rows.map((row) => row.id)));
  assert.equal(values.split("\n").length, 1935);
  assert.equal(values.split("\n").at(-1), rows.at(-1).id);
});

test("value rows without a string value are dropped rather than rendered as undefined", () => {
  const preview = ["plain", { value: "wrapped" }, { value: 42 }, { other: "x" }, null, ["a"], 7];

  assert.equal(listPreviewContent(result(preview)), "plain\nwrapped");
  assert.equal(listPreviewContent(result([])), "");
  assert.equal(listPreviewContent(undefined), "");
  assert.equal(previewContent(undefined), "");
});

test("each rendering answers for itself and repeats are free", () => {
  const shared = result(["a", "b"]);

  // Same result, two renderings: the memo must not hand one the other's text.
  assert.equal(listPreviewContent(shared), "a\nb");
  assert.equal(previewContent(shared), JSON.stringify(["a", "b"], null, 2));
  assert.equal(listPreviewContent(shared), "a\nb");
  assert.equal(previewContent(shared), JSON.stringify(["a", "b"], null, 2));
});
