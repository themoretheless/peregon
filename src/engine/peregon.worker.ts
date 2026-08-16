/// <reference lib="webworker" />

import init, {
  engine_version,
  process_request,
} from "../generated/peregon_engine/peregon_engine.js";
import type { EngineRequest } from "./types";
import { isValueVectorPlan } from "./value-vector-plan.ts";

interface IncomingMessage {
  id: number;
  request: EngineRequest;
}

const wasmReady = init();

/**
 * Loads the DuckDB backend on first use only. It pulls in
 * `@duckdb/duckdb-wasm` and `apache-arrow`, which would otherwise sit in the
 * worker entry that every session downloads. See docs/runtime-backends.md.
 */
const valueVectorBackend = () => import("./value-vector.ts");

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const { id, request } = event.data;
  const startedAt = performance.now();

  try {
    const response = request.action === "execute_plan" && isValueVectorPlan(request)
      ? await (await valueVectorBackend()).executeValueVectorPlan(request)
      : (await wasmReady, JSON.parse(process_request(JSON.stringify(request))));
    self.postMessage({
      id,
      response,
      durationMs: performance.now() - startedAt,
      engineVersion: engine_version(),
    });
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "WASM-модуль не ответил",
    });
  }
};
