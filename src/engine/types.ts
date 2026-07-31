export interface EngineError {
  message: string;
  line: number;
  column: number;
}

export interface FieldInfo {
  name: string;
  kind: "string" | "number" | "boolean" | "object" | "array" | "null" | "mixed";
  present: number;
}

export interface ArrayInfo {
  path: string;
  label: string;
  items: number;
  object_items: number;
  skipped_items: number;
  fields: FieldInfo[];
}

export type EngineRequest =
  | { action: "analyze"; json: string }
  | {
      action: "transform";
      json: string;
      path: string;
      fields: string[];
      delimiter: string;
      skip_empty: boolean;
      unique: boolean;
    };

export interface AnalyzeSuccess {
  ok: true;
  formatted_json: string;
  root_type: string;
  array_paths: ArrayInfo[];
}

export interface TransformSuccess {
  ok: true;
  output: string;
  source_items: number;
  object_items: number;
  skipped_items: number;
  empty_values: number;
  values: number;
}

export interface EngineFailure {
  ok: false;
  error: EngineError;
}

export type AnalyzeResponse = AnalyzeSuccess | EngineFailure;
export type TransformResponse = TransformSuccess | EngineFailure;

export interface TimedResponse<T> {
  response: T;
  durationMs: number;
  engineVersion: string;
}
