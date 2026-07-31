/// <reference lib="webworker" />

import init, {
  engine_version,
  process_json,
} from "../generated/json_engine/json_engine.js";
import type { EngineRequest } from "./types";

interface IncomingMessage {
  id: number;
  request: EngineRequest;
}

const wasmReady = init();

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  const { id, request } = event.data;
  const startedAt = performance.now();

  try {
    await wasmReady;
    const response = JSON.parse(process_json(JSON.stringify(request)));
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
