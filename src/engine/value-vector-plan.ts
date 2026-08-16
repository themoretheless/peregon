/**
 * Backend routing predicate for value-vector plans.
 *
 * This module is deliberately free of runtime imports: the worker must decide
 * whether a plan needs DuckDB *before* paying to load it. Keeping the check
 * here lets the executor, `@duckdb/duckdb-wasm` and `apache-arrow` stay in a
 * lazily imported chunk, per the browser policy in docs/runtime-backends.md.
 */
import type { ExecutePlanRequest, ExecutePlanStep, ExecuteSourceStep } from "../runtime/execute-plan.ts";

export const isVectorSource = (step: ExecutePlanStep): step is ExecuteSourceStep =>
  step.node_type === "source" && step.config.format === "list";

export const isVectorSink = (step: ExecutePlanStep): boolean =>
  step.node_type === "sink" && step.config.format === "template";

/** True when every step of the plan belongs to the value-vector pipeline. */
export const isValueVectorPlan = (request: ExecutePlanRequest): boolean =>
  request.plan.steps.length > 0
  && request.plan.steps.every((step) => isVectorSource(step) || isVectorSink(step));
