import type {
  NodeDefinition,
  NodeRegistry,
  PortContract,
  PortDefinition,
} from "./model.ts";

const RECORDS: PortContract = {
  kind: "record-set",
  formats: ["normalized"],
};

const VALUES: PortContract = {
  kind: "value-vector",
  formats: ["arrow"],
};

const input = (
  name: string,
  label: string,
  required = true,
  contract: PortContract = RECORDS,
): PortDefinition => ({
  name,
  label,
  direction: "input",
  cardinality: "one",
  required,
  contract,
});

const output = (name: string, label: string, contract: PortContract = RECORDS): PortDefinition => ({
  name,
  label,
  direction: "output",
  cardinality: "many",
  contract,
});

const source = (
  type: "source.json" | "source.csv" | "source.list",
  label: string,
  defaultConfig: NodeDefinition["defaultConfig"],
): NodeDefinition => ({
  type,
  version: 1,
  label,
  category: "source",
  ports: [output(
    type === "source.list" ? "values" : "records",
    type === "source.list" ? "Значения" : "Записи",
    type === "source.list" ? VALUES : RECORDS,
  )],
  defaultConfig,
});

const transform = (
  type: "transform.filter" | "transform.project",
  label: string,
  defaultConfig: NodeDefinition["defaultConfig"],
): NodeDefinition => ({
  type,
  version: 1,
  label,
  category: "transform",
  ports: [
    input("records", "Записи"),
    output("matched", "Результат"),
  ],
  defaultConfig,
});

const sink = (
  type: `sink.${"flat" | "template" | "json" | "csv" | "xml" | "sql"}`,
  label: string,
  defaultConfig: NodeDefinition["defaultConfig"],
): NodeDefinition => ({
  type,
  version: 1,
  label,
  category: "sink",
  ports: [input(
    type === "sink.template" ? "values" : "records",
    type === "sink.template" ? "Значения" : "Записи",
    true,
    type === "sink.template" ? VALUES : RECORDS,
  )],
  defaultConfig,
});

export const BUILTIN_NODE_DEFINITIONS: readonly NodeDefinition[] = [
  source("source.json", "JSON", { text: "", arrayPath: "" }),
  source("source.csv", "CSV", {
    text: "",
    delimiter: ",",
    includeHeader: true,
  }),
  source("source.list", "Список", { text: "", arrayPath: "" }),
  transform("transform.filter", "Фильтр строк", {
    mode: "all",
    conditions: [],
  }),
  transform("transform.project", "Выбрать поля", { fields: [] }),
  sink("sink.flat", "Плоский список", {
    delimiter: ", ",
    skipEmpty: true,
    unique: false,
    stripOuterQuotes: true,
  }),
  sink("sink.template", "По шаблону", {
    template: "0x{value}",
    delimiter: ",\n",
    skipEmpty: true,
    unique: false,
  }),
  sink("sink.json", "JSON", { pretty: true }),
  sink("sink.csv", "CSV", {
    delimiter: ",",
    includeHeader: true,
    quoteAll: false,
  }),
  sink("sink.xml", "XML", { root: "rows", row: "row" }),
  sink("sink.sql", "SQL", { table: "rows" }),
] as const;

export const BUILTIN_NODE_REGISTRY: NodeRegistry = new Map(
  BUILTIN_NODE_DEFINITIONS.map((definition) => [definition.type, definition]),
);
