import type {
  EngineRequest,
  PreviewDatasetResponse,
  ReleaseDatasetsResponse,
  TimedResponse,
} from "../engine/types.ts";
import type {
  JsonValue,
  NodeOutputResult,
  NodeResult,
  RuntimeDatasetRef,
  RuntimeDiagnostic,
  RuntimeFieldKind,
  RuntimePreview,
  RuntimeSchema,
  RuntimeValueKind,
} from "./contracts.ts";
import type {
  ExecutePlanDataSchema,
  ExecutePlanDatasetRef,
  ExecutePlanNodeResult,
  ExecutePlanRequest,
  ExecutePlanResponse,
  ExecutePlanStep,
} from "./execute-plan.ts";

/** Transport to the engine worker; JsonEngineClient satisfies it structurally. */
export interface RuntimeBackendClient {
  request<T>(request: EngineRequest): Promise<TimedResponse<T>>;
}

/**
 * Backend-neutral runtime contract from docs/runtime-backends.md. The plan
 * type is the stable snake_case wire plan the graph compiler already emits;
 * dataset refs stay opaque and are only valid within one backend session.
 */
export interface RuntimeBackend {
  readonly id: string;
  readonly sessionId: string;
  supports(request: ExecutePlanRequest): boolean;
  execute(request: ExecutePlanRequest, signal?: AbortSignal): AsyncIterable<NodeResult>;
  preview(ref: RuntimeDatasetRef, limit: number): Promise<RuntimePreview>;
  release(refs: readonly RuntimeDatasetRef[]): Promise<void>;
}

/**
 * Datasets a finished run no longer references. Equal node outputs share one
 * content-addressed id, so residency is decided per id rather than per node.
 */
export const selectStaleDatasets = (
  previous: readonly RuntimeDatasetRef[],
  next: readonly RuntimeDatasetRef[],
): RuntimeDatasetRef[] => {
  const retained = new Set(next.map((ref) => ref.datasetId));
  const seen = new Set<string>();
  return previous.filter((ref) => {
    if (retained.has(ref.datasetId) || seen.has(ref.datasetId)) return false;
    seen.add(ref.datasetId);
    return true;
  });
};

const SUPPORTED_NODE_TYPES = new Set(["source", "filter", "project", "sink"]);

const RUNTIME_FIELD_KINDS = new Set<RuntimeFieldKind>([
  "string", "number", "boolean", "object", "array", "null", "mixed", "unknown",
]);

const RUNTIME_VALUE_KINDS = new Set<RuntimeValueKind>([
  "records", "object", "array", "scalar", "text", "binary", "table",
]);

const createSessionId = (): string => {
  const generated = globalThis.crypto?.randomUUID?.();
  return generated ?? `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const fieldKind = (kind: string): RuntimeFieldKind =>
  RUNTIME_FIELD_KINDS.has(kind as RuntimeFieldKind) ? (kind as RuntimeFieldKind) : "unknown";

const valueKind = (kind: string): RuntimeValueKind =>
  RUNTIME_VALUE_KINDS.has(kind as RuntimeValueKind) ? (kind as RuntimeValueKind) : "records";

const toRuntimeSchema = (schema: ExecutePlanDataSchema | null): RuntimeSchema | undefined => {
  if (!schema) return undefined;
  if (schema.kind === "value-vector") {
    return {
      kind: "array",
      fields: [{ path: "/value", name: "value", kind: "string", nullable: false, optional: false }],
      revision: 0,
    };
  }
  return {
    kind: "records",
    fields: schema.fields.map((field) => ({
      path: `/${field.name}`,
      name: field.name,
      kind: fieldKind(field.kind),
      nullable: field.kind === "null" || field.kind === "mixed",
      optional: false,
    })),
    revision: 0,
  };
};

const toDiagnostics = (
  result: ExecutePlanNodeResult | undefined,
  fallbackNodeId: string,
): RuntimeDiagnostic[] =>
  (result?.diagnostics ?? []).map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    nodeId: issue.node_id ?? fallbackNodeId,
    ...(issue.expression_path ? { details: { expressionPath: issue.expression_path } } : {}),
  }));

const textPreview = (output: string): RuntimePreview => ({
  items: [output],
  totalItems: 1,
  truncated: false,
});

export class RustWasmBackend implements RuntimeBackend {
  readonly id = "rust-wasm";
  readonly sessionId = createSessionId();
  private readonly client: RuntimeBackendClient;

  constructor(client: RuntimeBackendClient) {
    this.client = client;
  }

  supports(request: ExecutePlanRequest): boolean {
    return (
      request.action === "execute_plan"
      && request.plan.version === 1
      && request.plan.steps.length > 0
      && request.plan.steps.every((step) => SUPPORTED_NODE_TYPES.has(step.node_type))
    );
  }

  /** Runs a plan and returns the raw wire response the UI renders directly. */
  run(request: ExecutePlanRequest): Promise<TimedResponse<ExecutePlanResponse>> {
    return this.client.request<ExecutePlanResponse>(request);
  }

  /**
   * Contract-shaped execution. The WASM engine executes the whole plan
   * atomically, so an abort only stops delivering the remaining node results.
   */
  async *execute(request: ExecutePlanRequest, signal?: AbortSignal): AsyncIterable<NodeResult> {
    signal?.throwIfAborted();
    const reply = await this.run(request);
    for (const step of request.plan.steps) {
      signal?.throwIfAborted();
      yield this.toNodeResult(step, request.plan.steps, reply.response);
    }
  }

  /** Attaches this backend's identity to a wire dataset reference. */
  datasetRef(dataset: ExecutePlanDatasetRef): RuntimeDatasetRef {
    return {
      datasetId: dataset.dataset_id,
      kind: valueKind(dataset.kind),
      contentHash: dataset.content_hash,
      backendId: this.id,
      sessionId: this.sessionId,
    };
  }

  async preview(ref: RuntimeDatasetRef, limit: number): Promise<RuntimePreview> {
    this.assertOwnRef(ref);
    const reply = await this.client.request<PreviewDatasetResponse>({
      action: "preview_dataset",
      dataset_id: ref.datasetId,
      limit,
    });
    if (!reply.response.ok) throw new Error(reply.response.error.message);
    return {
      items: reply.response.items as JsonValue[],
      totalItems: reply.response.total_items,
      truncated: reply.response.truncated,
    };
  }

  async release(refs: readonly RuntimeDatasetRef[]): Promise<void> {
    const own = refs.filter(
      (ref) => ref.backendId === this.id && ref.sessionId === this.sessionId,
    );
    if (own.length === 0) return;
    const reply = await this.client.request<ReleaseDatasetsResponse>({
      action: "release_datasets",
      dataset_ids: own.map((ref) => ref.datasetId),
    });
    if (!reply.response.ok) throw new Error(reply.response.error.message);
  }

  private assertOwnRef(ref: RuntimeDatasetRef): void {
    if (ref.backendId !== this.id) {
      throw new Error(`Датасет принадлежит другому backend: ${ref.backendId}`);
    }
    if (ref.sessionId !== this.sessionId) {
      throw new Error("Датасет из завершённой сессии недоступен, запустите граф ещё раз");
    }
  }

  private toNodeResult(
    step: ExecutePlanStep,
    steps: readonly ExecutePlanStep[],
    response: ExecutePlanResponse,
  ): NodeResult {
    const result = response.nodes[step.node_id];
    if (!result) {
      return {
        nodeId: step.node_id,
        status: "skipped",
        outputs: [],
        stats: {
          inputItems: 0, outputItems: 0, skippedItems: 0, errorItems: 0,
          durationMs: 0, cacheHit: false,
        },
        diagnostics: [],
      };
    }

    const outputs: NodeOutputResult[] = [];
    if (result.ok) {
      const consumerPort = steps.find(
        (candidate) => candidate.node_type !== "source" && candidate.input.node_id === step.node_id,
      )?.input?.port;
      const dataset = result.dataset ? this.datasetRef(result.dataset) : undefined;
      outputs.push({
        portId: consumerPort ?? "records",
        ...(dataset ? { dataset } : {}),
        schema: toRuntimeSchema(result.output_schema ?? result.input_schema),
        preview: {
          // The wire and contract JsonValue shapes differ only in readonly depth.
          items: [...result.preview] as JsonValue[],
          totalItems: result.stats.output_items,
          truncated: result.preview_truncated,
        },
      });
      const sinkOutput = response.sink_outputs[step.node_id];
      if (step.node_type === "sink" && sinkOutput !== undefined) {
        outputs.push({
          portId: "output",
          schema: { kind: "text", fields: [], revision: 0 },
          preview: textPreview(sinkOutput),
        });
      }
    }

    return {
      nodeId: step.node_id,
      status: result.ok ? (result.cached ? "cached" : "completed") : "failed",
      outputs,
      stats: {
        inputItems: result.stats.input_items,
        outputItems: result.stats.output_items,
        skippedItems: result.stats.skipped_items,
        errorItems: 0,
        durationMs: result.stats.duration_ms ?? 0,
        cacheHit: result.cached,
      },
      diagnostics: toDiagnostics(result, step.node_id),
    };
  }
}
