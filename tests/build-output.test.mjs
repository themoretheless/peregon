import assert from "node:assert/strict";
import { access, readFile, readdir, stat } from "node:fs/promises";
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

test("DuckDB stays out of the eagerly loaded worker entry", async () => {
  const assetNames = await readdir("dist/client/assets");
  const workerName = assetNames.find((name) => /^peregon\.worker-.*\.js$/.test(name));
  assert.ok(workerName, "engine worker entry is missing");

  const worker = await readFile(`dist/client/assets/${workerName}`, "utf8");
  // The worker must be able to decide it needs DuckDB without loading it.
  assert.doesNotMatch(worker, /DUCKDB_RUNTIME/);
  assert.match(worker, /import\(/, "the worker must reach DuckDB through a dynamic import");

  const chunks = await Promise.all(
    assetNames
      .filter((name) => name.endsWith(".js") && name !== workerName)
      .map(async (name) => [name, await readFile(`dist/client/assets/${name}`, "utf8")]),
  );
  const duckdbChunk = chunks.find(([, source]) => /DUCKDB_RUNTIME/.test(source));
  assert.ok(duckdbChunk, "DuckDB must ship as a separate lazily loaded chunk");

  const { size: workerSize } = await stat(`dist/client/assets/${workerName}`);
  const { size: duckdbSize } = await stat(`dist/client/assets/${duckdbChunk[0]}`);
  assert.ok(
    workerSize < duckdbSize,
    `worker entry (${workerSize} B) should be smaller than the DuckDB chunk (${duckdbSize} B)`,
  );
});

test("client build exposes project and direct package versions", async () => {
  const { version: projectVersion } = JSON.parse(
    await readFile("package.json", "utf8"),
  );
  const assetNames = await readdir("dist/client/assets");
  const scriptName = assetNames.find((name) => /^index-.*\.js$/.test(name));
  assert.ok(scriptName, "client entry script is missing");

  const script = await readFile(`dist/client/assets/${scriptName}`, "utf8");
  for (const expected of [
    "peregon",
    projectVersion,
    "@peregon/syntax-engine",
    "vue",
    "peregon_engine",
    "themoretheless-tokenizer",
  ]) {
    assert.match(script, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
