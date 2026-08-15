/**
 * Measurement spike for docs/runtime-backends.md: does a DuckDB-Wasm backend
 * pay for itself on `source.parquet → transform.aggregate → preview`?
 *
 * Dev-only. It is not referenced by index.html, so `vite build` never bundles
 * it; run it with `npm run dev` and open /spike/duckdb-parquet/.
 */
import { AsyncDuckDB, VoidLogger, type AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import duckdbMvpUrl from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import duckdbWorkerSource from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?raw";

const PREVIEW_LIMIT = 50;

const status = document.querySelector<HTMLElement>("#status")!;
const output = document.querySelector<HTMLElement>("#output")!;

const rowCount = (() => {
  const requested = Number(new URLSearchParams(location.search).get("rows"));
  return Number.isFinite(requested) && requested > 0 ? Math.trunc(requested) : 200_000;
})();

const say = (message: string) => {
  status.textContent = message;
};

const round = (value: number) => Math.round(value * 10) / 10;
const mib = (bytes: number) => round(bytes / (1024 * 1024));

const timed = async <T>(operation: () => Promise<T>): Promise<[T, number]> => {
  const startedAt = performance.now();
  const value = await operation();
  return [value, round(performance.now() - startedAt)];
};

/** Transferred size of the DuckDB assets, as the browser actually fetches them. */
async function measureAssets() {
  const wasmUrl = new URL(duckdbMvpUrl, location.href).href;
  const response = await fetch(wasmUrl);
  const wasmBytes = (await response.arrayBuffer()).byteLength;
  return {
    wasmMiB: mib(wasmBytes),
    workerScriptKiB: round(new Blob([duckdbWorkerSource]).size / 1024),
    encoding: response.headers.get("content-encoding") ?? "identity",
  };
}

/**
 * DuckDB's own accounting, read after a query settles. The bundle is
 * single-threaded, so a concurrent poll cannot interleave to catch the real
 * peak, and the worker's Wasm heap is not readable from this page.
 */
async function measureResidentMemory(connection: AsyncDuckDBConnection) {
  try {
    const result = await connection.query(
      "SELECT sum(memory_usage_bytes) AS used, sum(temporary_storage_bytes) AS spilled FROM duckdb_memory()",
    );
    const row = result.toArray()[0] as unknown as { used: bigint | number; spilled: bigint | number };
    return { usedMiB: mib(Number(row?.used ?? 0)), spilledMiB: mib(Number(row?.spilled ?? 0)) };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Bounds the working set by squeezing `memory_limit` until the workload spills
 * or fails. That answers the practical question behind "peak memory": how much
 * headroom this pipeline actually needs.
 */
async function probeMemoryLimits(connection: AsyncDuckDBConnection, aggregate: string) {
  const probes: Array<Record<string, unknown>> = [];
  for (const limit of ["512MB", "256MB", "128MB", "64MB", "32MB", "16MB"]) {
    try {
      await connection.query(`SET memory_limit='${limit}'`);
      const [, ms] = await timed(() => connection.query(`${aggregate} LIMIT ${PREVIEW_LIMIT}`));
      const after = await measureResidentMemory(connection);
      probes.push({ limit, ok: true, ms, spilledMiB: "spilledMiB" in after ? after.spilledMiB : null });
    } catch (error) {
      probes.push({ limit, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await connection.query("SET memory_limit='4GB'");
  return probes;
}

async function run() {
  const report: Record<string, unknown> = { rows: rowCount };

  // Cold start runs first: measuring assets beforehand would warm the HTTP
  // cache and quietly remove the asset fetch from the cold-start number.
  say("Холодный старт DuckDB…");
  const workerUrl = URL.createObjectURL(new Blob([duckdbWorkerSource], { type: "text/javascript" }));
  const [database, coldStartMs] = await timed(async () => {
    const instance = new AsyncDuckDB(new VoidLogger(), new Worker(workerUrl));
    await instance.instantiate(new URL(duckdbMvpUrl, location.href).href);
    await instance.open({ path: ":memory:" });
    return instance;
  });
  URL.revokeObjectURL(workerUrl);
  report.coldStartMs = coldStartMs;

  say("Измеряю размер assets…");
  report.assets = await measureAssets();

  const connection = await database.connect();
  try {
    say("Пишу parquet…");
    const [, writeMs] = await timed(() => connection.query(`
      COPY (
        SELECT
          i AS id,
          'Магазин ' || i AS name,
          ['Москва', 'Тверь', 'Казань', 'Сочи'][(i % 4) + 1] AS locality,
          (i % 7) AS state,
          ((i * 37) % 1000) / 10.0 AS revenue
        FROM range(${rowCount}) t(i)
      ) TO 'stores.parquet' (FORMAT PARQUET)
    `));
    const parquetBytes = (await database.copyFileToBuffer("stores.parquet")).byteLength;
    report.parquet = { writeMs, sizeMiB: mib(parquetBytes), bytesPerRow: round(parquetBytes / rowCount) };

    // Cold read: first touch of the parquet file, including metadata parsing.
    say("Агрегирую (холодное чтение)…");
    const aggregate = `
      SELECT locality, count(*) AS stores, round(sum(revenue), 2) AS revenue, round(avg(state), 3) AS avg_state
      FROM read_parquet('stores.parquet')
      GROUP BY locality
      ORDER BY revenue DESC
    `;
    const [coldPreview, coldPreviewMs] = await timed(async () =>
      (await connection.query(`${aggregate} LIMIT ${PREVIEW_LIMIT}`)).toArray().length);
    report.firstPreview = { rows: coldPreview, ms: coldPreviewMs };

    say("Агрегирую (повторно)…");
    const [, warmPreviewMs] = await timed(() => connection.query(`${aggregate} LIMIT ${PREVIEW_LIMIT}`));
    report.warmPreviewMs = warmPreviewMs;

    // A wide grouping keeps the preview honest: many groups, only 50 shown.
    say("Агрегирую с большим числом групп…");
    const [wideRows, widePreviewMs] = await timed(async () =>
      (await connection.query(`
        SELECT id % 5000 AS bucket, count(*) AS stores, round(sum(revenue), 2) AS revenue
        FROM read_parquet('stores.parquet')
        GROUP BY bucket ORDER BY revenue DESC LIMIT ${PREVIEW_LIMIT}
      `)).toArray().length);
    report.widePreview = { shownRows: wideRows, groups: Math.min(5000, rowCount), ms: widePreviewMs };

    say("Считаю память…");
    report.residentMemory = await measureResidentMemory(connection);

    say("Зондирую предел памяти…");
    report.memoryLimitProbes = await probeMemoryLimits(connection, aggregate);
    const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    report.pageJsHeapMiB = heap ? mib(heap.usedJSHeapSize) : "performance.memory недоступен";
  } finally {
    await connection.close();
    await database.terminate();
  }

  say("Готово");
  output.textContent = JSON.stringify(report, null, 2);
  (globalThis as { spikeReport?: unknown }).spikeReport = report;
}

run().catch((error) => {
  say("Ошибка");
  output.textContent = String(error instanceof Error ? error.stack ?? error.message : error);
});
