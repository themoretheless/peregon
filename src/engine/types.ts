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

export type FilterMode = "all" | "any";

export type FilterOperator =
  | "equal"
  | "not_equal"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "exists"
  | "not_exists";

export interface FilterCondition {
  field: string;
  operator: FilterOperator;
  value: string;
}

export type EngineRequest =
  | { action: "analyze"; json: string }
  | {
      action: "filter_preview";
      json: string;
      path: string;
      filters: FilterCondition[];
      filter_mode: FilterMode;
    }
  | {
      action: "transform";
      json: string;
      path: string;
      fields: string[];
      delimiter: string;
      skip_empty: boolean;
      unique: boolean;
      filters: FilterCondition[];
      filter_mode: FilterMode;
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
  matched_items: number;
  filtered_out: number;
  skipped_items: number;
  empty_values: number;
  values: number;
}

export interface FilterPreviewSuccess {
  ok: true;
  input_json: string;
  output_json: string;
  source_items: number;
  object_items: number;
  matched_items: number;
  filtered_out: number;
  skipped_items: number;
}

export interface EngineFailure {
  ok: false;
  error: EngineError;
}

export type AnalyzeResponse = AnalyzeSuccess | EngineFailure;
export type FilterPreviewResponse = FilterPreviewSuccess | EngineFailure;
export type TransformResponse = TransformSuccess | EngineFailure;

export interface TimedResponse<T> {
  response: T;
  durationMs: number;
  engineVersion: string;
}
