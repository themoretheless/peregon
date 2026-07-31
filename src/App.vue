<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { JsonEngineClient } from "./engine/client";
import type {
  AnalyzeResponse,
  AnalyzeSuccess,
  FilterCondition,
  FilterMode,
  FilterOperator,
  OutputFormat,
  SourceFormat,
  TransformResponse,
  TransformSuccess,
} from "./engine/types";
import { FlowSurfaceRenderer, type SurfaceEdge } from "./graph/webgpu";

type NodeKind = "source" | "fields" | "condition" | "output";
type PortDirection = "input" | "output";

interface UiCondition extends FilterCondition {
  id: number;
}

interface FlowNode {
  id: string;
  kind: NodeKind;
  title: string;
  x: number;
  y: number;
  json?: string;
  sourceFormat?: SourceFormat;
  csvDelimiter?: string;
  selectedPath?: string;
  selectedFields?: string[];
  conditions?: UiCondition[];
  filterMode?: FilterMode;
  delimiter?: string;
  outputFormat?: OutputFormat;
  tableName?: string;
  output?: string;
  stats?: TransformSuccess | null;
  error?: string;
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

interface EdgeVisual extends FlowEdge {
  path: string;
  midX: number;
  midY: number;
}

interface CacheEntry<T> {
  signature: string;
  response: T;
  engineVersion: string;
}

const SAMPLE_JSON = `{
  "stores": [
    {
      "id": "A-101",
      "name": "Москва 4-10",
      "locality": "Москва",
      "state": 1
    },
    {
      "id": "B-204",
      "name": "Белгород-2",
      "locality": "Белгород",
      "state": 1
    },
    {
      "id": "K-307",
      "name": "Курск-1",
      "locality": "Курск",
      "state": 0
    }
  ]
}`;

const SAMPLE_CSV = `id,name,locality,state
A-101,Москва 4-10,Москва,1
B-204,Белгород-2,Белгород,1
K-307,Курск-1,Курск,0`;

const NODE_META: Record<NodeKind, { label: string; eyebrow: string; icon: string; color: string }> = {
  source: { label: "Данные", eyebrow: "Источник", icon: "{ }", color: "#6557d9" },
  fields: { label: "Поля", eyebrow: "Проекция", icon: "⌗", color: "#367fbb" },
  condition: { label: "Условие", eyebrow: "Фильтрация", icon: "ƒ", color: "#159288" },
  output: { label: "Результат", eyebrow: "Выход", icon: "→", color: "#d06a35" },
};

const LIBRARY_BLOCKS: Array<{ key: string; kind: NodeKind; format?: SourceFormat; outputFormat?: OutputFormat; label: string; eyebrow: string; icon: string; color: string }> = [
  { key: "json", kind: "source", format: "json", label: "JSON", eyebrow: "Источник", icon: "{ }", color: "#6557d9" },
  { key: "csv", kind: "source", format: "csv", label: "CSV", eyebrow: "Источник", icon: "CSV", color: "#8b5fbf" },
  { key: "fields", kind: "fields", label: "Поля", eyebrow: "Проекция", icon: "⌗", color: "#367fbb" },
  { key: "condition", kind: "condition", label: "Условие", eyebrow: "Фильтрация", icon: "ƒ", color: "#159288" },
  { key: "flat", kind: "output", outputFormat: "flat", label: "Плоский список", eyebrow: "Выход", icon: "→", color: "#d06a35" },
  { key: "json-output", kind: "output", outputFormat: "json", label: "JSON", eyebrow: "Выход", icon: "{ }", color: "#d06a35" },
  { key: "csv-output", kind: "output", outputFormat: "csv", label: "CSV", eyebrow: "Выход", icon: "CSV", color: "#d06a35" },
  { key: "sql-output", kind: "output", outputFormat: "sql", label: "SQL INSERT", eyebrow: "Выход", icon: "SQL", color: "#d06a35" },
];

const FILTER_OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: "equal", label: "равно" },
  { value: "not_equal", label: "не равно" },
  { value: "greater_than", label: "больше" },
  { value: "greater_or_equal", label: "не меньше" },
  { value: "less_than", label: "меньше" },
  { value: "less_or_equal", label: "не больше" },
  { value: "contains", label: "содержит" },
  { value: "starts_with", label: "начинается с" },
  { value: "ends_with", label: "заканчивается на" },
  { value: "exists", label: "существует" },
  { value: "not_exists", label: "отсутствует" },
];

const nodes = ref<FlowNode[]>([
  { id: "source-1", kind: "source", title: "Данные магазинов", x: 80, y: 190, json: SAMPLE_JSON, sourceFormat: "json", csvDelimiter: "," },
  {
    id: "fields-1",
    kind: "fields",
    title: "Выбрать поля",
    x: 480,
    y: 135,
    selectedPath: "/stores",
    selectedFields: ["name"],
  },
  {
    id: "condition-1",
    kind: "condition",
    title: "Только активные",
    x: 865,
    y: 115,
    filterMode: "all",
    conditions: [{ id: 1, field: "state", operator: "equal", value: "1" }],
  },
  {
    id: "output-1",
    kind: "output",
    title: "Плоский список",
    x: 1280,
    y: 180,
    delimiter: ", ",
    outputFormat: "flat",
    tableName: "stores",
    output: "",
    stats: null,
  },
]);

const edges = ref<FlowEdge[]>([
  { id: "edge-1", from: "source-1", to: "fields-1" },
  { id: "edge-2", from: "fields-1", to: "condition-1" },
  { id: "edge-3", from: "condition-1", to: "output-1" },
]);

const analyses = reactive<Record<string, AnalyzeSuccess | undefined>>({});
const board = ref<HTMLElement | null>(null);
const surface = ref<HTMLCanvasElement | null>(null);
const panX = ref(0);
const panY = ref(0);
const zoom = ref(0.8);
const selectedNodeId = ref("");
const connectingFrom = ref("");
const connectionPreview = ref<{ x: number; y: number } | null>(null);
const edgeVisuals = ref<EdgeVisual[]>([]);
const gpuMode = ref<"loading" | "webgpu" | "canvas">("loading");
const engineVersion = ref("");
const isRunning = ref(false);
const lastRunMs = ref(0);
const cachedBranches = ref(0);
const notice = ref("Перетащите блок или соедините порты");

let client: JsonEngineClient | null = null;
let renderer: FlowSurfaceRenderer | null = null;
let resizeObserver: ResizeObserver | null = null;
let renderFrame = 0;
let executeTimer: number | undefined;
let executionToken = 0;
let nextNodeId = 2;
let nextEdgeId = 4;
let nextConditionId = 2;
let noticeTimer: number | undefined;
let connectionDrag: { fromId: string; startX: number; startY: number; moved: boolean } | null = null;
const analysisCache = new Map<string, CacheEntry<AnalyzeResponse>>();
const outputCache = new Map<string, CacheEntry<TransformResponse>>();

type Gesture =
  | { type: "pan"; startX: number; startY: number; originX: number; originY: number }
  | { type: "node"; nodeId: string; startX: number; startY: number; originX: number; originY: number }
  | null;
let gesture: Gesture = null;

const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`);
const executionSignature = computed(() =>
  JSON.stringify({
    edges: edges.value.map(({ from, to }) => [from, to]),
    nodes: nodes.value.map((node) => ({
      id: node.id,
      kind: node.kind,
      json: node.json,
      sourceFormat: node.sourceFormat,
      csvDelimiter: node.csvDelimiter,
      selectedPath: node.selectedPath,
      selectedFields: node.selectedFields,
      conditions: node.conditions,
      filterMode: node.filterMode,
      delimiter: node.delimiter,
      outputFormat: node.outputFormat,
      tableName: node.tableName,
    })),
  }),
);
const geometrySignature = computed(() =>
  JSON.stringify({
    panX: panX.value,
    panY: panY.value,
    zoom: zoom.value,
    nodes: nodes.value.map(({ id, x, y }) => [id, x, y]),
    edges: edges.value,
  }),
);

function nodeMeta(kind: NodeKind) {
  return NODE_META[kind];
}

function nodeDisplayMeta(node: FlowNode) {
  if (node.kind !== "source") return nodeMeta(node.kind);
  return node.sourceFormat === "csv"
    ? { label: "CSV", eyebrow: "Источник", icon: "CSV", color: "#8b5fbf" }
    : { label: "JSON", eyebrow: "Источник", icon: "{ }", color: "#6557d9" };
}

function nodeById(id: string) {
  return nodes.value.find((node) => node.id === id);
}

function incomingEdges(nodeId: string) {
  return edges.value.filter((edge) => edge.to === nodeId);
}

function outgoingEdges(nodeId: string) {
  return edges.value.filter((edge) => edge.from === nodeId);
}

function collectAncestors(nodeId: string, visited = new Set<string>()): FlowNode[] {
  const result: FlowNode[] = [];
  for (const edge of incomingEdges(nodeId)) {
    if (visited.has(edge.from)) continue;
    visited.add(edge.from);
    const parent = nodeById(edge.from);
    if (!parent) continue;
    result.push(parent, ...collectAncestors(parent.id, visited));
  }
  return result;
}

function upstreamSource(nodeId: string) {
  return collectAncestors(nodeId).find((node) => node.kind === "source");
}

function analysisForNode(nodeId: string) {
  const source = upstreamSource(nodeId);
  return source ? analyses[source.id] : undefined;
}

function arraysForNode(nodeId: string) {
  return analysisForNode(nodeId)?.array_paths ?? [];
}

function fieldsForNode(node: FlowNode) {
  const analysis = analysisForNode(node.id);
  const arrays = analysis?.array_paths ?? [];
  const selected = arrays.find((candidate) => candidate.path === node.selectedPath) ?? arrays[0];
  return selected?.fields ?? [];
}

function availableConditionFields(nodeId: string) {
  const ancestor = collectAncestors(nodeId).find((node) => node.kind === "fields");
  if (ancestor) return fieldsForNode(ancestor);
  const analysis = analysisForNode(nodeId);
  return analysis?.array_paths[0]?.fields ?? [];
}

function requiresValue(operator: FilterOperator) {
  return operator !== "exists" && operator !== "not_exists";
}

function setNotice(message: string) {
  notice.value = message;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    notice.value = "Перетащите блок или соедините порты";
  }, 2600);
}

function addNode(kind: NodeKind, sourceFormat: SourceFormat = "json", outputFormat: OutputFormat = "flat") {
  const bounds = board.value?.getBoundingClientRect();
  const centerX = bounds ? (bounds.width / 2 - panX.value) / zoom.value : 600;
  const centerY = bounds ? (bounds.height / 2 - panY.value) / zoom.value : 300;
  const id = `${kind}-${nextNodeId++}`;
  const base: FlowNode = {
    id,
    kind,
    title: `${kind === "source" ? sourceFormat.toUpperCase() : kind === "output" ? LIBRARY_BLOCKS.find((block) => block.outputFormat === outputFormat)?.label : NODE_META[kind].label} ${nextNodeId - 1}`,
    x: centerX - 170 + (nextNodeId % 3) * 24,
    y: centerY - 120 + (nextNodeId % 2) * 28,
  };
  if (kind === "source") {
    base.sourceFormat = sourceFormat;
    base.csvDelimiter = ",";
    base.json = sourceFormat === "csv" ? SAMPLE_CSV : SAMPLE_JSON;
  }
  if (kind === "fields") {
    base.selectedPath = "/stores";
    base.selectedFields = ["name"];
  }
  if (kind === "condition") {
    base.filterMode = "all";
    base.conditions = [{ id: nextConditionId++, field: "state", operator: "equal", value: "1" }];
  }
  if (kind === "output") {
    base.delimiter = ", ";
    base.csvDelimiter = ",";
    base.outputFormat = outputFormat;
    base.tableName = "result";
    base.output = "";
    base.stats = null;
  }
  nodes.value.push(base);
  selectedNodeId.value = id;
  setNotice(`Блок «${kind === "source" ? sourceFormat.toUpperCase() : kind === "output" ? outputFormat.toUpperCase() : NODE_META[kind].label}» добавлен`);
  scheduleRender();
}

function removeNode(id: string) {
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter((edge) => edge.from !== id && edge.to !== id);
  delete analyses[id];
  analysisCache.delete(id);
  outputCache.delete(id);
  if (selectedNodeId.value === id) selectedNodeId.value = "";
  if (connectingFrom.value === id) connectingFrom.value = "";
  scheduleRender();
}

function removeEdge(id: string) {
  edges.value = edges.value.filter((edge) => edge.id !== id);
  scheduleRender();
}

function handlePort(nodeId: string, direction: PortDirection) {
  if (direction === "output") {
    connectingFrom.value = connectingFrom.value === nodeId ? "" : nodeId;
    setNotice(connectingFrom.value ? "Теперь нажмите вход нужного блока" : "Соединение отменено");
    return;
  }
  if (!connectingFrom.value) {
    setNotice("Сначала нажмите выход блока-источника");
    return;
  }
  if (connectingFrom.value === nodeId) {
    setNotice("Нельзя соединить блок с самим собой");
    return;
  }
  connectNodes(connectingFrom.value, nodeId);
  connectingFrom.value = "";
  scheduleRender();
}

function connectNodes(fromId: string, toId: string) {
  if (fromId === toId) {
    setNotice("Нельзя соединить блок с самим собой");
    return;
  }
  const exists = edges.value.some((edge) => edge.from === fromId && edge.to === toId);
  if (!exists) {
    edges.value.push({ id: `edge-${nextEdgeId++}`, from: fromId, to: toId });
    setNotice("Блоки соединены — ветвление поддерживается");
  }
}

function startConnectionDrag(event: PointerEvent, nodeId: string) {
  if (event.button !== 0) return;
  const bounds = board.value?.getBoundingClientRect();
  if (!bounds) return;
  event.preventDefault();
  window.removeEventListener("pointermove", moveConnectionDrag);
  window.removeEventListener("pointerup", finishConnectionDrag);
  connectingFrom.value = nodeId;
  connectionPreview.value = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  connectionDrag = { fromId: nodeId, startX: event.clientX, startY: event.clientY, moved: false };
  window.addEventListener("pointermove", moveConnectionDrag);
  window.addEventListener("pointerup", finishConnectionDrag, { once: true });
  setNotice("Тяните линию к входной точке блока");
  scheduleRender();
}

function moveConnectionDrag(event: PointerEvent) {
  if (!connectionDrag) return;
  const bounds = board.value?.getBoundingClientRect();
  if (!bounds) return;
  if (Math.hypot(event.clientX - connectionDrag.startX, event.clientY - connectionDrag.startY) > 4) {
    connectionDrag.moved = true;
  }
  connectionPreview.value = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  scheduleRender();
}

function finishConnectionDrag(event: PointerEvent) {
  const drag = connectionDrag;
  window.removeEventListener("pointermove", moveConnectionDrag);
  connectionDrag = null;
  connectionPreview.value = null;
  if (!drag) return;

  const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  const inputPort = target?.closest<HTMLElement>("[data-input-port]");
  const targetId = inputPort?.dataset.inputPort;
  if (targetId) {
    connectNodes(drag.fromId, targetId);
    connectingFrom.value = "";
  } else if (drag.moved) {
    connectingFrom.value = "";
    setNotice("Связь отменена — отпустите линию на входной точке");
  } else {
    setNotice("Теперь нажмите входную точку нужного блока");
  }
  scheduleRender();
}

function cancelConnection(render = true) {
  window.removeEventListener("pointermove", moveConnectionDrag);
  window.removeEventListener("pointerup", finishConnectionDrag);
  connectionDrag = null;
  connectionPreview.value = null;
  connectingFrom.value = "";
  if (render) scheduleRender();
}

function toggleField(node: FlowNode, field: string) {
  const selected = node.selectedFields ?? [];
  node.selectedFields = selected.includes(field)
    ? selected.filter((name) => name !== field)
    : [...selected, field];
}

function addCondition(node: FlowNode) {
  const fields = availableConditionFields(node.id);
  node.conditions = [
    ...(node.conditions ?? []),
    {
      id: nextConditionId++,
      field: fields.find((field) => field.name === "state")?.name ?? fields[0]?.name ?? "state",
      operator: "equal",
      value: "1",
    },
  ];
}

function removeCondition(node: FlowNode, conditionId: number) {
  node.conditions = (node.conditions ?? []).filter((condition) => condition.id !== conditionId);
}

function startNodeDrag(event: PointerEvent, node: FlowNode) {
  if (event.button !== 0) return;
  selectedNodeId.value = node.id;
  gesture = {
    type: "node",
    nodeId: node.id,
    startX: event.clientX,
    startY: event.clientY,
    originX: node.x,
    originY: node.y,
  };
  beginGesture();
}

function startPan(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) return;
  selectedNodeId.value = "";
  connectingFrom.value = "";
  gesture = {
    type: "pan",
    startX: event.clientX,
    startY: event.clientY,
    originX: panX.value,
    originY: panY.value,
  };
  beginGesture();
}

function beginGesture() {
  window.addEventListener("pointermove", moveGesture);
  window.addEventListener("pointerup", endGesture, { once: true });
}

function moveGesture(event: PointerEvent) {
  if (!gesture) return;
  if (gesture.type === "pan") {
    panX.value = gesture.originX + event.clientX - gesture.startX;
    panY.value = gesture.originY + event.clientY - gesture.startY;
  } else {
    const node = nodeById(gesture.nodeId);
    if (!node) return;
    node.x = gesture.originX + (event.clientX - gesture.startX) / zoom.value;
    node.y = gesture.originY + (event.clientY - gesture.startY) / zoom.value;
  }
}

function endGesture() {
  gesture = null;
  window.removeEventListener("pointermove", moveGesture);
}

function handleWheel(event: WheelEvent) {
  event.preventDefault();
  const bounds = board.value?.getBoundingClientRect();
  if (!bounds) return;
  const pointerX = event.clientX - bounds.left;
  const pointerY = event.clientY - bounds.top;
  const worldX = (pointerX - panX.value) / zoom.value;
  const worldY = (pointerY - panY.value) / zoom.value;
  const nextZoom = Math.min(1.65, Math.max(0.42, zoom.value * Math.exp(-event.deltaY * 0.0012)));
  zoom.value = nextZoom;
  panX.value = pointerX - worldX * nextZoom;
  panY.value = pointerY - worldY * nextZoom;
}

function changeZoom(delta: number) {
  const bounds = board.value?.getBoundingClientRect();
  if (!bounds) return;
  const next = Math.min(1.65, Math.max(0.42, zoom.value + delta));
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const worldX = (centerX - panX.value) / zoom.value;
  const worldY = (centerY - panY.value) / zoom.value;
  zoom.value = next;
  panX.value = centerX - worldX * next;
  panY.value = centerY - worldY * next;
}

function fitView() {
  const bounds = board.value?.getBoundingClientRect();
  if (!bounds || !nodes.value.length) return;
  const minX = Math.min(...nodes.value.map((node) => node.x));
  const minY = Math.min(...nodes.value.map((node) => node.y));
  const maxX = Math.max(...nodes.value.map((node) => node.x + (node.kind === "condition" ? 370 : 340)));
  const maxY = Math.max(...nodes.value.map((node) => node.y + 420));
  const availableWidth = Math.max(480, bounds.width - 300);
  const availableHeight = Math.max(360, bounds.height - 110);
  const next = Math.min(1, Math.max(0.42, Math.min(availableWidth / (maxX - minX), availableHeight / (maxY - minY))));
  zoom.value = next;
  panX.value = 270 + (availableWidth - (maxX - minX) * next) / 2 - minX * next;
  panY.value = 70 + (availableHeight - (maxY - minY) * next) / 2 - minY * next;
}

function resetGraph() {
  window.location.reload();
}

function scheduleRender() {
  cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(async () => {
    await nextTick();
    renderSurface();
  });
}

function edgeGeometry(fromX: number, fromY: number, toX: number, toY: number) {
  const distance = Math.max(80, Math.abs(toX - fromX) * 0.52);
  const control1X = fromX + distance;
  const control2X = toX - distance;
  return {
    path: `M ${fromX} ${fromY} C ${control1X} ${fromY}, ${control2X} ${toY}, ${toX} ${toY}`,
    midX: (fromX + 3 * control1X + 3 * control2X + toX) / 8,
    midY: (fromY + toY) / 2,
  };
}

function renderSurface() {
  const canvas = surface.value;
  const boardElement = board.value;
  if (!canvas || !boardElement || !renderer) return;
  const canvasRect = canvas.getBoundingClientRect();
  const surfaceEdges: SurfaceEdge[] = [];
  const visuals: EdgeVisual[] = [];
  const colors: Record<NodeKind, [number, number, number, number]> = {
    source: [0.4, 0.34, 0.85, 0.92],
    fields: [0.21, 0.5, 0.73, 0.92],
    condition: [0.08, 0.57, 0.53, 0.92],
    output: [0.82, 0.42, 0.21, 0.92],
  };
  for (const edge of edges.value) {
    const fromPort = boardElement.querySelector<HTMLElement>(`[data-output-port="${edge.from}"]`);
    const toPort = boardElement.querySelector<HTMLElement>(`[data-input-port="${edge.to}"]`);
    if (!fromPort || !toPort) continue;
    const fromRect = fromPort.getBoundingClientRect();
    const toRect = toPort.getBoundingClientRect();
    const kind = nodeById(edge.from)?.kind ?? "source";
    const positioned = {
      fromX: fromRect.left + fromRect.width / 2 - canvasRect.left,
      fromY: fromRect.top + fromRect.height / 2 - canvasRect.top,
      toX: toRect.left + toRect.width / 2 - canvasRect.left,
      toY: toRect.top + toRect.height / 2 - canvasRect.top,
      color: colors[kind],
    };
    surfaceEdges.push(positioned);
    visuals.push({ ...edge, ...edgeGeometry(positioned.fromX, positioned.fromY, positioned.toX, positioned.toY) });
  }

  if (connectingFrom.value && connectionPreview.value) {
    const fromPort = boardElement.querySelector<HTMLElement>(`[data-output-port="${connectingFrom.value}"]`);
    if (fromPort) {
      const fromRect = fromPort.getBoundingClientRect();
      const kind = nodeById(connectingFrom.value)?.kind ?? "source";
      surfaceEdges.push({
        fromX: fromRect.left + fromRect.width / 2 - canvasRect.left,
        fromY: fromRect.top + fromRect.height / 2 - canvasRect.top,
        toX: connectionPreview.value.x,
        toY: connectionPreview.value.y,
        color: colors[kind],
      });
    }
  }
  edgeVisuals.value = visuals;
  renderer.render({ panX: panX.value, panY: panY.value, zoom: zoom.value, edges: surfaceEdges });
}

function scheduleExecute(immediate = false) {
  window.clearTimeout(executeTimer);
  executeTimer = window.setTimeout(executeGraph, immediate ? 0 : 480);
}

function applyAnalysisResult(sourceNode: FlowNode, response: AnalyzeResponse) {
  sourceNode.error = "";
  if (!response.ok) {
    delete analyses[sourceNode.id];
    sourceNode.error = response.error.message;
    return;
  }
  analyses[sourceNode.id] = response;
}

function applyOutputResult(outputNode: FlowNode, response: TransformResponse) {
  outputNode.error = "";
  if (!response.ok) {
    outputNode.output = "";
    outputNode.stats = null;
    outputNode.error = response.error.message;
    return;
  }
  outputNode.output = response.output;
  outputNode.stats = response;
}

async function executeGraph() {
  if (!client) return;
  const token = ++executionToken;
  const startedAt = performance.now();
  isRunning.value = true;
  cachedBranches.value = 0;

  try {
    const sourceNodes = nodes.value.filter((node) => node.kind === "source");
    await Promise.all(
      sourceNodes.map(async (sourceNode) => {
        const signature = JSON.stringify({
          data: sourceNode.json ?? "",
          format: sourceNode.sourceFormat ?? "json",
          csvDelimiter: sourceNode.csvDelimiter ?? ",",
        });
        const cached = analysisCache.get(sourceNode.id);
        if (cached?.signature === signature) {
          engineVersion.value = cached.engineVersion;
          applyAnalysisResult(sourceNode, cached.response);
          return;
        }
        const reply = await client!.request<AnalyzeResponse>({
          action: "analyze",
          json: sourceNode.json ?? "",
          source_format: sourceNode.sourceFormat ?? "json",
          csv_delimiter: sourceNode.csvDelimiter ?? ",",
        });
        if (token !== executionToken) return;
        analysisCache.set(sourceNode.id, {
          signature,
          response: reply.response,
          engineVersion: reply.engineVersion,
        });
        engineVersion.value = reply.engineVersion;
        applyAnalysisResult(sourceNode, reply.response);
      }),
    );
    if (token !== executionToken) return;

    for (const fieldNode of nodes.value.filter((node) => node.kind === "fields")) {
      const availableArrays = arraysForNode(fieldNode.id);
      const selectedArray =
        availableArrays.find((candidate) => candidate.path === fieldNode.selectedPath) ?? availableArrays[0];
      if (selectedArray && fieldNode.selectedPath !== selectedArray.path) fieldNode.selectedPath = selectedArray.path;
      const availableNames = new Set(selectedArray?.fields.map((field) => field.name) ?? []);
      fieldNode.selectedFields = (fieldNode.selectedFields ?? []).filter((field) => availableNames.has(field));
      if (!fieldNode.selectedFields.length && selectedArray?.fields.length) {
        fieldNode.selectedFields = [
          selectedArray.fields.find((field) => field.name === "name")?.name ?? selectedArray.fields[0].name,
        ];
      }
    }

    const outputs = nodes.value.filter((node) => node.kind === "output");
    await Promise.all(
      outputs.map(async (outputNode) => {
        outputNode.error = "";
        const ancestors = collectAncestors(outputNode.id);
        const sourceNode = ancestors.find((node) => node.kind === "source");
        const fieldNode = ancestors.find((node) => node.kind === "fields");
        const conditionNodes = ancestors.filter((node) => node.kind === "condition");
        if (!sourceNode || !fieldNode) {
          outputCache.delete(outputNode.id);
          outputNode.output = "";
          outputNode.stats = null;
          outputNode.error = "Соедините источник данных и блок полей";
          return;
        }
        const selectedFields = fieldNode.selectedFields ?? [];
        if (!selectedFields.length) {
          outputCache.delete(outputNode.id);
          outputNode.output = "";
          outputNode.stats = null;
          outputNode.error = "В блоке полей ничего не выбрано";
          return;
        }
        const filters = conditionNodes.flatMap((node) => node.conditions ?? []);
        const request = {
          action: "transform",
          json: sourceNode.json ?? "",
          path: fieldNode.selectedPath ?? "",
          fields: selectedFields,
          delimiter: outputNode.delimiter ?? ", ",
          skip_empty: true,
          unique: false,
          filters: filters.map(({ field, operator, value }) => ({ field, operator, value })),
          filter_mode: conditionNodes[0]?.filterMode ?? "all",
          source_format: sourceNode.sourceFormat ?? "json",
          csv_delimiter: sourceNode.csvDelimiter ?? ",",
          output_format: outputNode.outputFormat ?? "flat",
          output_csv_delimiter: outputNode.csvDelimiter ?? ",",
          table_name: outputNode.tableName ?? "result",
        } as const;
        const signature = JSON.stringify(request);
        const cached = outputCache.get(outputNode.id);
        if (cached?.signature === signature) {
          cachedBranches.value += 1;
          engineVersion.value = cached.engineVersion;
          applyOutputResult(outputNode, cached.response);
          return;
        }
        const reply = await client!.request<TransformResponse>(request);
        if (token !== executionToken) return;
        outputCache.set(outputNode.id, {
          signature,
          response: reply.response,
          engineVersion: reply.engineVersion,
        });
        engineVersion.value = reply.engineVersion;
        applyOutputResult(outputNode, reply.response);
      }),
    );
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "Не удалось выполнить граф");
  } finally {
    if (token === executionToken) {
      isRunning.value = false;
      lastRunMs.value = performance.now() - startedAt;
      scheduleRender();
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const editing = target?.matches("input, textarea, select, [contenteditable='true']");
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    executeGraph();
    return;
  }
  if (!editing && (event.key === "Delete" || event.key === "Backspace") && selectedNodeId.value) {
    event.preventDefault();
    removeNode(selectedNodeId.value);
  }
  if (!editing && event.key === "Escape") cancelConnection();
}

watch(geometrySignature, scheduleRender);
watch(executionSignature, () => scheduleExecute());

onMounted(async () => {
  client = new JsonEngineClient();
  if (surface.value) {
    renderer = new FlowSurfaceRenderer(surface.value);
    gpuMode.value = await renderer.init();
  }
  resizeObserver = new ResizeObserver(scheduleRender);
  if (board.value) resizeObserver.observe(board.value);
  window.addEventListener("keydown", handleKeydown);
  await nextTick();
  fitView();
  scheduleExecute(true);
  scheduleRender();
});

onBeforeUnmount(() => {
  executionToken += 1;
  window.clearTimeout(executeTimer);
  window.clearTimeout(noticeTimer);
  cancelAnimationFrame(renderFrame);
  endGesture();
  cancelConnection(false);
  resizeObserver?.disconnect();
  renderer?.destroy();
  client?.terminate();
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div class="flow-app">
    <header class="flow-topbar">
      <div class="flow-brand">
        <span class="flow-brand-mark">JR</span>
        <span>
          <strong>JSON RIVET</strong>
          <small>Visual pipeline</small>
        </span>
      </div>

      <div class="flow-document-title">
        <span class="save-dot"></span>
        <strong>Обработка магазинов</strong>
        <small>{{ nodes.length }} блоков · {{ edges.length }} связей</small>
      </div>

      <div class="flow-top-actions">
        <span class="runtime-pill" :class="gpuMode">
          <i></i>{{ gpuMode === "webgpu" ? "WebGPU" : gpuMode === "canvas" ? "Canvas fallback" : "GPU…" }}
        </span>
        <span class="runtime-pill wasm" :class="{ ready: engineVersion }">
          <i></i>{{ engineVersion ? `WASM ${engineVersion}` : "WASM…" }}
        </span>
        <button type="button" class="run-button" :disabled="isRunning" @click="executeGraph">
          <span>{{ isRunning ? "•••" : "▶" }}</span>
          {{ isRunning ? "Выполняется" : "Запустить" }}
        </button>
      </div>
    </header>

    <main
      ref="board"
      class="flow-board"
      :class="{ connecting: connectingFrom, dragging: gesture }"
      @pointerdown="startPan"
      @wheel="handleWheel"
    >
      <canvas ref="surface" class="flow-surface" aria-hidden="true"></canvas>
      <svg class="edge-interactions" aria-label="Связи между блоками">
        <g v-for="edge in edgeVisuals" :key="edge.id" class="edge-hit">
          <path class="edge-hit-path" :d="edge.path" @pointerdown.stop />
          <g
            class="edge-delete"
            :transform="`translate(${edge.midX} ${edge.midY})`"
            role="button"
            tabindex="0"
            :aria-label="`Удалить связь ${nodeById(edge.from)?.title ?? ''} — ${nodeById(edge.to)?.title ?? ''}`"
            @pointerdown.stop
            @click.stop="removeEdge(edge.id)"
            @keydown.enter.prevent="removeEdge(edge.id)"
            @keydown.space.prevent="removeEdge(edge.id)"
          >
            <circle r="11"></circle>
            <path d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5"></path>
          </g>
        </g>
      </svg>

      <aside class="block-library" aria-label="Библиотека блоков" @pointerdown.stop>
        <div class="library-heading">
          <span>Блоки</span>
          <strong>Добавить на холст</strong>
        </div>
        <div class="library-list">
          <button
            v-for="block in LIBRARY_BLOCKS"
            :key="block.key"
            type="button"
            class="library-item"
            :style="{ '--node-color': block.color }"
            @click="addNode(block.kind, block.format, block.outputFormat)"
          >
            <span class="library-icon">{{ block.icon }}</span>
            <span>
              <strong>{{ block.label }}</strong>
              <small>{{ block.eyebrow }}</small>
            </span>
            <b>+</b>
          </button>
        </div>
        <div class="library-tip">
          <span>⌘</span>
          <p>Тяните связь от точки к точке. Наведите на линию, чтобы удалить.</p>
        </div>
      </aside>

      <div
        class="node-layer"
        :style="{ transform: `translate(${panX}px, ${panY}px) scale(${zoom})` }"
      >
        <article
          v-for="node in nodes"
          :key="node.id"
          class="flow-node"
          :class="[`node-${node.kind}`, { selected: selectedNodeId === node.id }]"
          :style="{
            transform: `translate(${node.x}px, ${node.y}px)`,
            '--node-color': nodeDisplayMeta(node).color,
          }"
          @pointerdown.stop="selectedNodeId = node.id"
        >
          <button
            v-if="node.kind !== 'source'"
            type="button"
            class="node-port input-port"
            :class="{ awaiting: connectingFrom }"
            :data-input-port="node.id"
            :aria-label="`Подключить вход блока ${node.title}`"
            @pointerdown.stop
            @click.stop="handlePort(node.id, 'input')"
          ></button>

          <header class="node-heading" @pointerdown.stop="startNodeDrag($event, node)">
            <span class="node-icon">{{ nodeDisplayMeta(node).icon }}</span>
            <div>
              <small>{{ nodeDisplayMeta(node).eyebrow }}</small>
              <input v-model="node.title" aria-label="Название блока" @pointerdown.stop />
            </div>
            <button
              type="button"
              class="node-delete"
              :aria-label="`Удалить блок ${node.title}`"
              @pointerdown.stop
              @click.stop="removeNode(node.id)"
            >×</button>
          </header>

          <div class="node-body" @pointerdown.stop>
            <template v-if="node.kind === 'source'">
              <div class="source-format-row">
                <span>Формат</span>
                <strong>{{ (node.sourceFormat ?? 'json').toUpperCase() }}</strong>
                <label v-if="node.sourceFormat === 'csv'">
                  Разделитель
                  <input v-model="node.csvDelimiter" maxlength="1" aria-label="Разделитель CSV" />
                </label>
              </div>
              <div class="node-label-row">
                <span>{{ (node.sourceFormat ?? 'json').toUpperCase() }}</span>
                <small v-if="analyses[node.id]" class="node-ok">корректный</small>
                <small v-else-if="node.error" class="node-bad">ошибка</small>
              </div>
              <textarea
                v-model="node.json"
                class="node-code-input"
                spellcheck="false"
                :aria-label="`Исходные данные ${node.sourceFormat ?? 'json'}`"
              ></textarea>
              <p v-if="node.error" class="node-error">{{ node.error }}</p>
              <div v-else-if="analyses[node.id]" class="source-stats">
                <span>{{ analyses[node.id]?.array_paths.length }} набор</span>
                <span>{{ (node.json ?? '').length }} символов</span>
              </div>
            </template>

            <template v-else-if="node.kind === 'fields'">
              <label class="node-control">
                <span>Массив</span>
                <select v-model="node.selectedPath">
                  <option
                    v-for="array in arraysForNode(node.id)"
                    :key="array.path"
                    :value="array.path"
                  >{{ array.label }} · {{ array.items }}</option>
                </select>
              </label>
              <div class="node-label-row fields-label">
                <span>Оставить поля</span>
                <small>{{ node.selectedFields?.length ?? 0 }} выбрано</small>
              </div>
              <div v-if="fieldsForNode(node).length" class="node-field-list">
                <button
                  v-for="field in fieldsForNode(node)"
                  :key="field.name"
                  type="button"
                  :class="{ active: node.selectedFields?.includes(field.name) }"
                  @click="toggleField(node, field.name)"
                >
                  <span>{{ node.selectedFields?.includes(field.name) ? "✓" : "+" }}</span>
                  <code>{{ field.name }}</code>
                  <small>{{ field.kind }}</small>
                </button>
              </div>
              <div v-else class="node-empty">Подключите источник данных</div>
            </template>

            <template v-else-if="node.kind === 'condition'">
              <div class="condition-mode" role="group" aria-label="Логика условий">
                <button
                  type="button"
                  :class="{ active: node.filterMode === 'all' }"
                  @click="node.filterMode = 'all'"
                >Все <small>И</small></button>
                <button
                  type="button"
                  :class="{ active: node.filterMode === 'any' }"
                  @click="node.filterMode = 'any'"
                >Любое <small>ИЛИ</small></button>
              </div>
              <div class="condition-subblocks">
                <div
                  v-for="(condition, index) in node.conditions"
                  :key="condition.id"
                  class="condition-subblock"
                >
                  <span class="subblock-index">{{ index + 1 }}</span>
                  <select v-model="condition.field" aria-label="Поле условия">
                    <option
                      v-for="field in availableConditionFields(node.id)"
                      :key="field.name"
                      :value="field.name"
                    >{{ field.name }}</option>
                  </select>
                  <select v-model="condition.operator" aria-label="Оператор условия">
                    <option
                      v-for="operator in FILTER_OPERATORS"
                      :key="operator.value"
                      :value="operator.value"
                    >{{ operator.label }}</option>
                  </select>
                  <input
                    v-if="requiresValue(condition.operator)"
                    v-model="condition.value"
                    aria-label="Значение условия"
                    placeholder="значение"
                  />
                  <span v-else class="unary-value">без значения</span>
                  <button
                    type="button"
                    class="subblock-delete"
                    aria-label="Удалить условие"
                    @click="removeCondition(node, condition.id)"
                  >×</button>
                </div>
              </div>
              <button type="button" class="add-subblock" @click="addCondition(node)">
                <span>+</span> Подусловие
              </button>
            </template>

            <template v-else>
              <label class="node-control compact-control output-format-control">
                <span>Формат</span>
                <select v-model="node.outputFormat" aria-label="Формат результата">
                  <option value="flat">Плоский список</option>
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="sql">SQL INSERT</option>
                </select>
              </label>
              <label v-if="node.outputFormat === 'flat'" class="node-control compact-control">
                <span>Разделитель</span>
                <input v-model="node.delimiter" maxlength="12" />
              </label>
              <label v-else-if="node.outputFormat === 'csv'" class="node-control compact-control">
                <span>Разделитель CSV</span>
                <input v-model="node.csvDelimiter" maxlength="1" />
              </label>
              <label v-else-if="node.outputFormat === 'sql'" class="node-control compact-control table-control">
                <span>Таблица</span>
                <input v-model="node.tableName" maxlength="64" placeholder="stores" />
              </label>
              <div class="node-label-row">
                <span>Результат</span>
                <small v-if="node.stats" class="node-ok">{{ node.stats.values }} значений</small>
              </div>
              <textarea
                class="node-result-output"
                :value="node.output || (node.error ? '' : 'Результат появится здесь')"
                readonly
                aria-label="Результат блока"
              ></textarea>
              <p v-if="node.error" class="node-error">{{ node.error }}</p>
              <div v-else-if="node.stats" class="output-stats">
                <span><strong>{{ node.stats.matched_items }}</strong> прошло</span>
                <span><strong>{{ node.stats.filtered_out }}</strong> отсеяно</span>
              </div>
            </template>
          </div>

          <footer v-if="outgoingEdges(node.id).length" class="node-connections" @pointerdown.stop>
            <button
              v-for="edge in outgoingEdges(node.id)"
              :key="edge.id"
              type="button"
              :title="`Удалить связь с ${nodeById(edge.to)?.title ?? 'блоком'}`"
              @click="removeEdge(edge.id)"
            >→ {{ nodeById(edge.to)?.title ?? "блок" }} <span>×</span></button>
          </footer>

          <button
            v-if="node.kind !== 'output'"
            type="button"
            class="node-port output-port"
            :class="{ active: connectingFrom === node.id }"
            :data-output-port="node.id"
            :aria-label="`Перетащить связь из блока ${node.title}`"
            @pointerdown.stop="startConnectionDrag($event, node.id)"
          ></button>
        </article>
      </div>

      <div class="canvas-status" aria-live="polite" @pointerdown.stop>
        <span :class="{ pulse: connectingFrom }"></span>
        {{ notice }}
      </div>

      <div class="zoom-controls" aria-label="Масштаб холста" @pointerdown.stop>
        <button type="button" aria-label="Уменьшить" @click="changeZoom(-0.1)">−</button>
        <button type="button" class="zoom-value" @click="fitView">{{ zoomLabel }}</button>
        <button type="button" aria-label="Увеличить" @click="changeZoom(0.1)">+</button>
        <button type="button" class="fit-button" @click="fitView">Вписать</button>
      </div>

      <div class="run-status" @pointerdown.stop>
        <span v-if="isRunning" class="run-spinner"></span>
        <span v-else class="run-check">✓</span>
        <div>
          <strong>{{ isRunning ? "Выполняю граф" : "Граф актуален" }}</strong>
          <small>{{ isRunning
            ? "Проверяю изменённые ветки"
            : `${Math.round(lastRunMs)} мс · ${cachedBranches ? `${cachedBranches} из кэша` : "пересчитано"}`
          }}</small>
        </div>
        <button type="button" title="Сбросить доску" @click="resetGraph">↺</button>
      </div>
    </main>
  </div>
</template>
