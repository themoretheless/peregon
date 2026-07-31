import type { FilterOperator } from "../engine/types.ts";
import type { FilterExpression } from "./filter-expression.ts";

export type UiFilterExpression =
  | {
      id: number;
      kind: "condition";
      field: string;
      operator: FilterOperator;
      value: string;
    }
  | {
      id: number;
      kind: "group";
      operator: "and" | "or";
      children: UiFilterExpression[];
    }
  | {
      id: number;
      kind: "not";
      child: UiFilterExpression;
    };

let nextFilterExpressionId = 10_000;

export const createUiCondition = (field = "state"): UiFilterExpression => ({
  id: nextFilterExpressionId++,
  kind: "condition",
  field,
  operator: "equal",
  value: "1",
});

export const createUiFilterGroup = (
  operator: "and" | "or" = "and",
  field = "state",
): UiFilterExpression => ({
  id: nextFilterExpressionId++,
  kind: "group",
  operator,
  children: [createUiCondition(field)],
});

export const legacyConditionsToUiExpression = (
  conditions: readonly { field: string; operator: FilterOperator; value: string }[],
  mode: "all" | "any",
): UiFilterExpression => ({
  id: nextFilterExpressionId++,
  kind: "group",
  operator: mode === "any" ? "or" : "and",
  children: conditions.map((condition) => ({
    id: nextFilterExpressionId++,
    kind: "condition" as const,
    field: condition.field,
    operator: condition.operator,
    value: condition.value,
  })),
});

export const filterExpressionToUi = (expression: FilterExpression): UiFilterExpression => {
  if (expression.kind === "condition") {
    return {
      id: nextFilterExpressionId++,
      kind: "condition",
      field: expression.field,
      operator: expression.operator,
      value: expression.value ?? "",
    };
  }
  if (expression.kind === "not") {
    return {
      id: nextFilterExpressionId++,
      kind: "not",
      child: filterExpressionToUi(expression.child),
    };
  }
  return {
    id: nextFilterExpressionId++,
    kind: "group",
    operator: expression.operator,
    children: expression.children.map(filterExpressionToUi),
  };
};
