import assert from "node:assert/strict";
import test from "node:test";

import { RustWasmBackend } from "../src/runtime/index.ts";

const planRequest = {
  action: "execute_plan",
  plan: {
    version: 1,
    graph_id: "g",
    graph_revision: 1,
    preview_limit: 50,
    steps: [
      {
        node_id: "source",
        node_type: "source",
        cache_key: "s",
        config: { data: "[]", format: "json", path: "", csv_delimiter: "," },
      },
      {
        node_id: "sink",
        node_type: "sink",
        cache_key: "k",
        input: { node_id: "source", port: "records" },
        config: {
          format: "csv", delimiter: ", ", skip_empty: true, unique: false,
          csv_delimiter: ";", csv_include_header: true, csv_quote_all: false,
          xml_root: "rows", xml_row: "row", table_name: "rows",
          value_template: "{value}", strip_outer_quotes: true,
        },
      },
    ],
  },
};

const stats = { input_items: 2, output_items: 2, filtered_out: 0, skipped_items: 0 };

const wireResponse = {
  ok: true,
  nodes: {
    source: {
      ok: true,
      cached: false,
      preview: [{ id: "A1" }],
      preview_truncated: true,
      dataset: { dataset_id: "ds-abc", kind: "records", content_hash: "abc" },
      schema: { kind: "records", fields: [{ name: "id", kind: "string", present: 2 }] },
      input_schema: null,
      output_schema: { kind: "records", fields: [{ name: "id", kind: "string", present: 2 }] },
      stats,
      diagnostics: [],
    },
    sink: {
      ok: true,
      cached: true,
      preview: [{ id: "A1" }],
      preview_truncated: false,
      dataset: { dataset_id: "ds-abc", kind: "records", content_hash: "abc" },
      schema: null,
      input_schema: { kind: "records", fields: [{ name: "id", kind: "string", present: 2 }] },
      output_schema: null,
      stats,
      diagnostics: [],
    },
  },
  sink_outputs: { sink: "id\nA1" },
  diagnostics: [],
};

const createFakeClient = (respond) => {
  const requests = [];
  return {
    requests,
    request(request) {
      requests.push(request);
      return Promise.resolve({
        response: respond(request),
        durationMs: 1,
        engineVersion: "test",
      });
    },
  };
};

const collect = async (iterable) => {
  const results = [];
  for await (const item of iterable) results.push(item);
  return results;
};

test("supports accepts the wire plan and rejects unknown steps", () => {
  const backend = new RustWasmBackend(createFakeClient(() => wireResponse));
  assert.equal(backend.supports(planRequest), true);
  const foreign = {
    ...planRequest,
    plan: {
      ...planRequest.plan,
      steps: [{ ...planRequest.plan.steps[0], node_type: "aggregate" }],
    },
  };
  assert.equal(backend.supports(foreign), false);
});

test("execute converts wire results into contract node results with session-scoped refs", async () => {
  const backend = new RustWasmBackend(createFakeClient(() => wireResponse));
  const results = await collect(backend.execute(planRequest));

  assert.deepEqual(results.map((result) => result.nodeId), ["source", "sink"]);
  const [source, sink] = results;

  assert.equal(source.status, "completed");
  assert.equal(source.outputs[0].portId, "records");
  assert.deepEqual(source.outputs[0].dataset, {
    datasetId: "ds-abc",
    kind: "records",
    contentHash: "abc",
    backendId: "rust-wasm",
    sessionId: backend.sessionId,
  });
  assert.deepEqual(source.outputs[0].schema, {
    kind: "records",
    fields: [{ path: "/id", name: "id", kind: "string", nullable: false, optional: false }],
    revision: 0,
  });
  assert.deepEqual(source.outputs[0].preview, {
    items: [{ id: "A1" }],
    totalItems: 2,
    truncated: true,
  });
  assert.equal(source.stats.cacheHit, false);

  assert.equal(sink.status, "cached");
  assert.equal(sink.stats.cacheHit, true);
  const textOutput = sink.outputs.find((output) => output.portId === "output");
  assert.deepEqual(textOutput.preview, { items: ["id\nA1"], totalItems: 1, truncated: false });
});

test("execute marks failed and missing nodes", async () => {
  const failure = {
    ok: false,
    nodes: {
      source: {
        ok: false,
        cached: false,
        preview: [],
        preview_truncated: false,
        dataset: null,
        schema: null,
        input_schema: null,
        output_schema: null,
        stats: { input_items: 0, output_items: 0, filtered_out: 0, skipped_items: 0 },
        diagnostics: [{ severity: "error", code: "invalid_source", message: "bad", node_id: "source" }],
      },
    },
    sink_outputs: {},
    diagnostics: [],
  };
  const backend = new RustWasmBackend(createFakeClient(() => failure));
  const [source, sink] = await collect(backend.execute(planRequest));
  assert.equal(source.status, "failed");
  assert.equal(source.outputs.length, 0);
  assert.equal(source.diagnostics[0].code, "invalid_source");
  assert.equal(sink.status, "skipped");
});

test("execute stops delivering results after abort", async () => {
  const backend = new RustWasmBackend(createFakeClient(() => wireResponse));
  const controller = new AbortController();
  const iterator = backend.execute(planRequest, controller.signal)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value.nodeId, "source");
  controller.abort();
  await assert.rejects(() => iterator.next());
});

test("preview resolves own refs and rejects foreign ones", async () => {
  const client = createFakeClient((request) => {
    assert.equal(request.action, "preview_dataset");
    assert.equal(request.dataset_id, "ds-abc");
    assert.equal(request.limit, 500);
    return {
      ok: true,
      dataset_id: "ds-abc",
      kind: "records",
      content_hash: "abc",
      items: [{ id: "A1" }, { id: "B2" }],
      total_items: 2,
      truncated: false,
    };
  });
  const backend = new RustWasmBackend(client);
  const ref = backend.datasetRef({ dataset_id: "ds-abc", kind: "records", content_hash: "abc" });

  const sample = await backend.preview(ref, 500);
  assert.deepEqual(sample, { items: [{ id: "A1" }, { id: "B2" }], totalItems: 2, truncated: false });

  await assert.rejects(() => backend.preview({ ...ref, backendId: "duckdb-wasm" }, 10));
  await assert.rejects(() => backend.preview({ ...ref, sessionId: "another-session" }, 10));
  assert.equal(client.requests.length, 1);
});

test("preview surfaces engine errors for evicted datasets", async () => {
  const backend = new RustWasmBackend(createFakeClient(() => ({
    ok: false,
    error: { message: "выгружены из памяти", line: 0, column: 0 },
  })));
  const ref = backend.datasetRef({ dataset_id: "ds-gone", kind: "records", content_hash: "gone" });
  await assert.rejects(() => backend.preview(ref, 10), /выгружены из памяти/u);
});

test("release sends only this session's refs and skips empty requests", async () => {
  const client = createFakeClient((request) => {
    assert.equal(request.action, "release_datasets");
    assert.deepEqual(request.dataset_ids, ["ds-abc"]);
    return { ok: true, released: 1 };
  });
  const backend = new RustWasmBackend(client);
  const own = backend.datasetRef({ dataset_id: "ds-abc", kind: "records", content_hash: "abc" });
  const foreign = { ...own, datasetId: "ds-x", sessionId: "another-session" };

  await backend.release([own, foreign]);
  assert.equal(client.requests.length, 1);

  await backend.release([foreign]);
  assert.equal(client.requests.length, 1);
});
