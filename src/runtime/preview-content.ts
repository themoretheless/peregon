import type { ExecutePlanNodeResult } from "./execute-plan.ts";

// A node preview holds every row, and the same result is rendered by both the
// node card and the inspector within one run. Serialize each result once per
// rendering and let the text fall out of the map with the result itself. The
// two renderings keep separate maps so a result can never answer with the
// other one's text.
const asRecords = new WeakMap<ExecutePlanNodeResult, string>();
const asValues = new WeakMap<ExecutePlanNodeResult, string>();

function memoized(
  cache: WeakMap<ExecutePlanNodeResult, string>,
  result: ExecutePlanNodeResult | undefined,
  render: (result: ExecutePlanNodeResult) => string,
): string {
  if (!result) return "";

  const cached = cache.get(result);
  if (cached !== undefined) return cached;

  const text = render(result);
  cache.set(result, text);
  return text;
}

/** Renders a record preview the way the node card and the inspector show it. */
export function previewContent(result: ExecutePlanNodeResult | undefined): string {
  return memoized(asRecords, result, (value) => JSON.stringify(value.preview, null, 2));
}

/**
 * Renders a value-vector preview as plain lines. Rows carrying no string value
 * are dropped rather than shown as `undefined`.
 */
export function listPreviewContent(result: ExecutePlanNodeResult | undefined): string {
  return memoized(asValues, result, (value) => value.preview.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const nested = (item as Readonly<Record<string, unknown>>).value;
    return typeof nested === "string" ? [nested] : [];
  }).join("\n"));
}
