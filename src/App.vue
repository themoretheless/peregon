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
  selectedPath?: string;
  selectedFields?: string[];
  conditions?: UiCondition[];
  filterMode?: FilterMode;
  delimiter?: string;
  output?: string;
  stats?: TransformSuccess | null;
  error?: string;
}

interface FlowEdge {
  id: string;
  from: string;
  to: string;
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

const NODE_META: Record<NodeKind, { label: string; eyebrow: string; icon: string; color: string }> = {
  source: { label: "JSON", eyebrow: "Источник", icon: "{ }", color: "#6557d9" },
  fields: { label: "Поля", eyebrow: "Проекция", icon: "⌗", color: "#367fbb" },
  condition: { label: "Условие", eyebrow: "Фильтрация", icon: "ƒ", color: "#159288" },
  output: { label: "Результат", eyebrow: "Выход", icon: "→", color: "#d06a35" },
};

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
  { id: "source-1", kind: "source", title: "Данные магазинов", x: 80, y: 190, json: SAMPLE_JSON },
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
const gpuMode = ref<"loading" | "webgpu" | "canvas">("loading");
const engineVersion = ref("");
const isRunning = ref(false);
const lastRunMs = ref(0);
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
      selectedPath: node.selectedPath,
      selectedFields: node.selectedFields,
      conditions: node.conditions,
      filterMode: node.filterMode,
      delimiter: node.delimiter,
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

function addNode(kind: NodeKind) {
  const bounds = board.value?.getBoundingClientRect();
  const centerX = bounds ? (bounds.width / 2 - panX.value) / zoom.value : 600;
  const centerY = bounds ? (bounds.height / 2 - panY.value) / zoom.value : 300;
  const id = `${kind}-${nextNodeId++}`;
  const base: FlowNode = {
    id,
    kind,
    title: `${NODE_META[kind].label} ${nextNodeId - 1}`,
    x: centerX - 170 + (nextNodeId % 3) * 24,
    y: centerY - 120 + (nextNodeId % 2) * 28,
  };
  if (kind === "source") base.json = SAMPLE_JSON;
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
    base.output = "";
    base.stats = null;
  }
  nodes.value.push(base);
  selectedNodeId.value = id;
  setNotice(`Блок «${NODE_META[kind].label}» добавлен`);
  scheduleRender();
}

function removeNode(id: string) {
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter((edge) => edge.from !== id && edge.to !== id);
  delete analyses[id];
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
  const exists = edges.value.some((edge) => edge.from === connectingFrom.value && edge.to === nodeId);
  if (!exists) {
    edges.value.push({ id: `edge-${nextEdgeId++}`, from: connectingFrom.value, to: nodeId });
    setNotice("Блоки соединены — ветвление поддерживается");
  }
  connectingFrom.value = "";
  scheduleRender();
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

function renderSurface() {
  const canvas = surface.value;
  const boardElement = board.value;
  if (!canvas || !boardElement || !renderer) return;
  const canvasRect = canvas.getBoundingClientRect();
  const surfaceEdges: SurfaceEdge[] = [];
  for (const edge of edges.value) {
    const fromPort = boardElement.querySelector<HTMLElement>(`[data-output-port="${edge.from}"]`);
    const toPort = boardElement.querySelector<HTMLElement>(`[data-input-port="${edge.to}"]`);
    if (!fromPort || !toPort) continue;
    const fromRect = fromPort.getBoundingClientRect();
    const toRect = toPort.getBoundingClientRect();
    const kind = nodeById(edge.from)?.kind ?? "source";
    const colors: Record<NodeKind, [number, number, number, number]> = {
      source: [0.4, 0.34, 0.85, 0.92],
      fields: [0.21, 0.5, 0.73, 0.92],
      condition: [0.08, 0.57, 0.53, 0.92],
      output: [0.82, 0.42, 0.21, 0.92],
    };
    surfaceEdges.push({
      fromX: fromRect.left + fromRect.width / 2 - canvasRect.left,
      fromY: fromRect.top + fromRect.height / 2 - canvasRect.top,
      toX: toRect.left + toRect.width / 2 - canvasRect.left,
      toY: toRect.top + toRect.height / 2 - canvasRect.top,
      color: colors[kind],
    });
  }
  renderer.render({ panX: panX.value, panY: panY.value, zoom: zoom.value, edges: surfaceEdges });
}

function scheduleExecute(immediate = false) {
  window.clearTimeout(executeTimer);
  executeTimer = window.setTimeout(executeGraph, immediate ? 0 : 480);
}

async function executeGraph() {
  if (!client) return;
  const token = ++executionToken;
  const startedAt = performance.now();
  isRunning.value = true;

  try {
    const sourceNodes = nodes.value.filter((node) => node.kind === "source");
    await Promise.all(
      sourceNodes.map(async (sourceNode) => {
        sourceNode.error = "";
        const reply = await client!.request<AnalyzeResponse>({
          action: "analyze",
          json: sourceNode.json ?? "",
        });
        if (token !== executionToken) return;
        engineVersion.value = reply.engineVersion;
        if (!reply.response.ok) {
          delete analyses[sourceNode.id];
          sourceNode.error = reply.response.error.message;
          return;
        }
        analyses[sourceNode.id] = reply.response;
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
          outputNode.output = "";
          outputNode.stats = null;
          outputNode.error = "Соедините источник JSON и блок полей";
          return;
        }
        const selectedFields = fieldNode.selectedFields ?? [];
        if (!selectedFields.length) {
          outputNode.output = "";
          outputNode.stats = null;
          outputNode.error = "В блоке полей ничего не выбрано";
          return;
        }
        const filters = conditionNodes.flatMap((node) => node.conditions ?? []);
        const reply = await client!.request<TransformResponse>({
          action: "transform",
          json: sourceNode.json ?? "",
          path: fieldNode.selectedPath ?? "",
          fields: selectedFields,
          delimiter: outputNode.delimiter ?? ", ",
          skip_empty: true,
          unique: false,
          filters: filters.map(({ field, operator, value }) => ({ field, operator, value })),
          filter_mode: conditionNodes[0]?.filterMode ?? "all",
        });
        if (token !== executionToken) return;
        engineVersion.value = reply.engineVersion;
        if (!reply.response.ok) {
          outputNode.output = "";
          outputNode.stats = null;
          outputNode.error = reply.response.error.message;
          return;
        }
        outputNode.output = reply.response.output;
        outputNode.stats = reply.response;
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
  if (!editing && event.key === "Escape") connectingFrom.value = "";
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

      <aside class="block-library" aria-label="Библиотека блоков" @pointerdown.stop>
        <div class="library-heading">
          <span>Блоки</span>
          <strong>Добавить на холст</strong>
        </div>
        <div class="library-list">
          <button
            v-for="kind in (Object.keys(NODE_META) as NodeKind[])"
            :key="kind"
            type="button"
            class="library-item"
            :style="{ '--node-color': nodeMeta(kind).color }"
            @click="addNode(kind)"
          >
            <span class="library-icon">{{ nodeMeta(kind).icon }}</span>
            <span>
              <strong>{{ nodeMeta(kind).label }}</strong>
              <small>{{ nodeMeta(kind).eyebrow }}</small>
            </span>
            <b>+</b>
          </button>
        </div>
        <div class="library-tip">
          <span>⌘</span>
          <p>Выход блока можно подключить к нескольким входам.</p>
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
            '--node-color': nodeMeta(node.kind).color,
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
            <span class="node-icon">{{ nodeMeta(node.kind).icon }}</span>
            <div>
              <small>{{ nodeMeta(node.kind).eyebrow }}</small>
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
              <div class="node-label-row">
                <span>JSON</span>
                <small v-if="analyses[node.id]" class="node-ok">корректный</small>
                <small v-else-if="node.error" class="node-bad">ошибка</small>
              </div>
              <textarea
                v-model="node.json"
                class="node-code-input"
                spellcheck="false"
                aria-label="Исходный JSON блока"
              ></textarea>
              <p v-if="node.error" class="node-error">{{ node.error }}</p>
              <div v-else-if="analyses[node.id]" class="source-stats">
                <span>{{ analyses[node.id]?.array_paths.length }} массив</span>
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
              <div v-else class="node-empty">Подключите блок JSON</div>
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
              <label class="node-control compact-control">
                <span>Разделитель</span>
                <input v-model="node.delimiter" maxlength="12" />
              </label>
              <div class="node-label-row">
                <span>Результат</span>
                <small v-if="node.stats" class="node-ok">{{ node.stats.values }} значений</small>
              </div>
              <textarea
                class="node-output"
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
            :aria-label="`Начать связь из блока ${node.title}`"
            @pointerdown.stop
            @click.stop="handlePort(node.id, 'output')"
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
          <small>{{ isRunning ? "Rust/WASM обрабатывает блоки" : `${Math.round(lastRunMs)} мс · локально` }}</small>
        </div>
        <button type="button" title="Сбросить доску" @click="resetGraph">↺</button>
      </div>
    </main>
  </div>
</template>
