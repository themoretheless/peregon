import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("Sites build contains the Vue client and Worker entry", async () => {
  await Promise.all([
    access("dist/client/index.html"),
    access("dist/server/index.js"),
    access("dist/.openai/hosting.json"),
  ]);

  const html = await readFile("dist/client/index.html", "utf8");
  assert.match(html, /Peregon/);
  assert.match(html, /assets\//);
});
