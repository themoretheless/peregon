<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { JsonEngineClient } from "./engine/client";
import type {
  AnalyzeResponse,
  AnalyzeSuccess,
  EngineError,
  TransformResponse,
  TransformSuccess,
} from "./engine/types";

const SAMPLE_JSON = `{
  "stores": [
    {
      "id": "000D3A2155A180E411E79A1A1E9C37AC",
      "name": "Москва 4-10",
      "departmentId": "000D3A2480C380DB11E6B24E64032541",
      "departmentName": "Москва 4",
      "locality": "Москва",
      "state": 1
    },
    {
      "id": "000D3A2155A180E411E79C94155E4FA5",
      "name": "Белгород-2",
      "departmentId": "000D3A240C719A8711E68ABA13FC5A0E",
      "departmentName": "Белгород",
      "locality": "Белгород",
      "state": 1
    }
  ]
}`;

const WARNING_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;

const jsonInput = ref(SAMPLE_JSON);
const analysis = ref<AnalyzeSuccess | null>(null);
const parseError = ref<EngineError | null>(null);
const runtimeError = ref("");
const selectedPath = ref("");
const selectedFields = ref<string[]>([]);
const delimiter = ref(", ");
const skipEmpty = ref(true);
const unique = ref(false);
const result = ref<TransformSuccess | null>(null);
const transformError = ref<EngineError | null>(null);
const isAnalyzing = ref(false);
const isTransforming = ref(false);
const engineVersion = ref("");
const durationMs = ref(0);
const copyState = ref<"idle" | "done" | "error">("idle");
const editor = ref<HTMLTextAreaElement | null>(null);
const lineGutter = ref<HTMLElement | null>(null);

let client: JsonEngineClient | null = null;
let analyzeTimer: number | undefined;
let transformTimer: number | undefined;
let copyTimer: number | undefined;
let analyzeToken = 0;
let transformToken = 0;

const inputBytes = computed(() => new TextEncoder().encode(jsonInput.value).length);
const inputLines = computed(() => (jsonInput.value.match(/\n/g)?.length ?? 0) + 1);
const lineNumbers = computed(() => {
  const visibleLines = Math.min(inputLines.value, 5000);
  const lines = Array.from({ length: visibleLines }, (_, index) => String(index + 1));
  if (inputLines.value > visibleLines) lines.push("⋮");
  return lines.join("\n");
});

const currentArray = computed(() =>
  analysis.value?.array_paths.find((candidate) => candidate.path === selectedPath.value),
);

const allFieldsSelected = computed(
  () =>
    !!currentArray.value?.fields.length &&
    currentArray.value.fields.every((field) => selectedFields.value.includes(field.name)),
);

const hasOutput = computed(() => Boolean(result.value?.output));
const fieldOrderPreview = computed(() => {
  if (!selectedFields.value.length) return "Сначала выберите хотя бы одно поле";
  const names = selectedFields.value.map((field) => `«${field}»`).join(" → ");
  return `Объект 1: ${names} · затем объект 2`;
});

const delimiterText = computed({
  get: () => delimiter.value.replace(/\t/g, "\\t").replace(/\n/g, "\\n"),
  set: (value: string) => {
    delimiter.value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
  },
});

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1) return "< 1 мс";
  return `${Math.round(milliseconds)} мс`;
}

function scheduleAnalyze(immediate = false) {
  window.clearTimeout(analyzeTimer);
  analyzeTimer = window.setTimeout(runAnalyze, immediate ? 0 : 320);
}

async function runAnalyze() {
  if (!client) return;
  const token = ++analyzeToken;
  transformToken += 1;
  runtimeError.value = "";
  transformError.value = null;

  if (!jsonInput.value.trim()) {
    analysis.value = null;
    parseError.value = null;
    result.value = null;
    isAnalyzing.value = false;
    return;
  }

  if (inputBytes.value > MAX_INPUT_BYTES) {
    analysis.value = null;
    result.value = null;
    parseError.value = {
      message: "Файл больше 12 МБ. Разделите его на части, чтобы не перегружать вкладку.",
      line: 0,
      column: 0,
    };
    return;
  }

  isAnalyzing.value = true;
  try {
    const reply = await client.request<AnalyzeResponse>({
      action: "analyze",
      json: jsonInput.value,
    });
    if (token !== analyzeToken) return;

    engineVersion.value = reply.engineVersion;
    durationMs.value = reply.durationMs;
    if (!reply.response.ok) {
      analysis.value = null;
      result.value = null;
      parseError.value = reply.response.error;
      return;
    }

    analysis.value = reply.response;
    parseError.value = null;

    const pathStillExists = reply.response.array_paths.some(
      (candidate) => candidate.path === selectedPath.value,
    );
    if (!pathStillExists) {
      const preferred =
        reply.response.array_paths.find((candidate) => candidate.fields.length > 0) ??
        reply.response.array_paths[0];
      selectedPath.value = preferred?.path ?? "";
    }

    const candidate = reply.response.array_paths.find(
      (item) => item.path === selectedPath.value,
    );
    const available = new Set(candidate?.fields.map((field) => field.name) ?? []);
    selectedFields.value = selectedFields.value.filter((field) => available.has(field));
    if (!selectedFields.value.length && candidate?.fields.length) {
      selectedFields.value = [
        candidate.fields.find((field) => field.name === "name")?.name ??
          candidate.fields[0].name,
      ];
    }

    scheduleTransform(true);
  } catch (error) {
    if (token === analyzeToken) {
      runtimeError.value =
        error instanceof Error ? error.message : "Не удалось запустить Rust/WASM";
      analysis.value = null;
      result.value = null;
    }
  } finally {
    if (token === analyzeToken) isAnalyzing.value = false;
  }
}

function scheduleTransform(immediate = false) {
  window.clearTimeout(transformTimer);
  transformTimer = window.setTimeout(runTransform, immediate ? 0 : 120);
}

async function runTransform() {
  if (!client || !analysis.value || !currentArray.value || !selectedFields.value.length) {
    result.value = null;
    transformError.value = null;
    return;
  }

  const token = ++transformToken;
  isTransforming.value = true;
  try {
    const reply = await client.request<TransformResponse>({
      action: "transform",
      json: jsonInput.value,
      path: selectedPath.value,
      fields: [...selectedFields.value],
      delimiter: delimiter.value,
      skip_empty: skipEmpty.value,
      unique: unique.value,
    });
    if (token !== transformToken) return;

    engineVersion.value = reply.engineVersion;
    durationMs.value = reply.durationMs;
    if (!reply.response.ok) {
      result.value = null;
      transformError.value = reply.response.error;
      return;
    }

    result.value = reply.response;
    transformError.value = null;
  } catch (error) {
    if (token === transformToken) {
      runtimeError.value = error instanceof Error ? error.message : "Ошибка преобразования";
      result.value = null;
    }
  } finally {
    if (token === transformToken) isTransforming.value = false;
  }
}

function toggleField(name: string) {
  if (selectedFields.value.includes(name)) {
    selectedFields.value = selectedFields.value.filter((field) => field !== name);
  } else {
    selectedFields.value = [...selectedFields.value, name];
  }
}

function selectAllFields() {
  selectedFields.value = currentArray.value?.fields.map((field) => field.name) ?? [];
}

function clearFields() {
  selectedFields.value = [];
}

function moveField(index: number, direction: -1 | 1) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= selectedFields.value.length) return;
  const reordered = [...selectedFields.value];
  [reordered[index], reordered[nextIndex]] = [reordered[nextIndex], reordered[index]];
  selectedFields.value = reordered;
}

function useSample() {
  jsonInput.value = SAMPLE_JSON;
  scheduleAnalyze(true);
}

function clearInput() {
  jsonInput.value = "";
  editor.value?.focus();
}

function formatInput() {
  if (!analysis.value) return;
  jsonInput.value = analysis.value.formatted_json;
  scheduleAnalyze(true);
}

async function copyOutput() {
  if (!result.value?.output) return;
  try {
    await navigator.clipboard.writeText(result.value.output);
    copyState.value = "done";
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = result.value.output;
    fallback.style.position = "fixed";
    fallback.style.opacity = "0";
    document.body.appendChild(fallback);
    fallback.select();
    copyState.value = document.execCommand("copy") ? "done" : "error";
    fallback.remove();
  }
  window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => (copyState.value = "idle"), 1800);
}

function downloadOutput() {
  if (!result.value?.output) return;
  const url = URL.createObjectURL(
    new Blob([result.value.output], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "json-rivet-result.txt";
  link.click();
  URL.revokeObjectURL(url);
}

function syncEditorScroll() {
  if (editor.value && lineGutter.value) {
    lineGutter.value.scrollTop = editor.value.scrollTop;
  }
}

function handleShortcut(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === "Enter") {
    event.preventDefault();
    runTransform();
  }
  if (event.shiftKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copyOutput();
  }
}

watch(jsonInput, () => scheduleAnalyze());
watch(
  [
    selectedPath,
    () => selectedFields.value.join("\u0000"),
    delimiter,
    skipEmpty,
    unique,
  ],
  () => scheduleTransform(),
);

onMounted(async () => {
  client = new JsonEngineClient();
  window.addEventListener("keydown", handleShortcut);
  await nextTick();
  scheduleAnalyze(true);
});

onBeforeUnmount(() => {
  window.clearTimeout(analyzeTimer);
  window.clearTimeout(transformTimer);
  window.clearTimeout(copyTimer);
  window.removeEventListener("keydown", handleShortcut);
  client?.terminate();
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="#top" aria-label="JSON Rivet — наверх">
        <span class="brand-mark" aria-hidden="true">JR</span>
        <span>
          <strong>JSON RIVET</strong>
          <small>Vue × Rust/WASM</small>
        </span>
      </a>
      <div class="topbar-status">
        <span class="privacy-pill"><i></i> Данные остаются в браузере</span>
        <span class="engine-pill" :class="{ ready: engineVersion }">
          {{ engineVersion ? `WASM v${engineVersion}` : "WASM загружается" }}
        </span>
      </div>
    </header>

    <main id="top">
      <section class="hero" aria-labelledby="page-title">
        <div>
          <p class="eyebrow">Локальный конвейер преобразований</p>
          <h1 id="page-title">JSON <span>в плоский список</span></h1>
        </div>
        <p class="hero-copy">
          Вставьте JSON, выберите массив и нужные поля. Rust-модуль соберёт
          значения в одну строку — быстро и без отправки данных на сервер.
        </p>
      </section>

      <nav class="pipeline" aria-label="Этапы преобразования">
        <div class="pipeline-step active">
          <span>01</span>
          <strong>Исходный JSON</strong>
        </div>
        <i aria-hidden="true">→</i>
        <div class="pipeline-step" :class="{ active: currentArray }">
          <span>02</span>
          <strong>Фильтр полей</strong>
        </div>
        <i aria-hidden="true">→</i>
        <div class="pipeline-step" :class="{ active: result }">
          <span>03</span>
          <strong>Плоский список</strong>
        </div>
      </nav>

      <div class="workbench">
        <section class="panel input-panel" aria-labelledby="input-title">
          <div class="panel-heading">
            <div>
              <span class="step-number">01</span>
              <div>
                <p>Входные данные</p>
                <h2 id="input-title">Исходный JSON</h2>
              </div>
            </div>
            <span v-if="isAnalyzing" class="working"><i></i> Разбор…</span>
            <span v-else-if="analysis" class="valid-badge">Корректный</span>
          </div>

          <div class="toolbar" aria-label="Действия с JSON">
            <button type="button" class="text-button" @click="useSample">Пример</button>
            <button
              type="button"
              class="text-button"
              :disabled="!analysis"
              @click="formatInput"
            >
              Форматировать
            </button>
            <button type="button" class="text-button muted" @click="clearInput">
              Очистить
            </button>
          </div>

          <div class="code-editor" :class="{ invalid: parseError || runtimeError }">
            <pre ref="lineGutter" class="line-gutter" aria-hidden="true">{{ lineNumbers }}</pre>
            <textarea
              ref="editor"
              v-model="jsonInput"
              aria-label="Исходный JSON"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              @scroll="syncEditorScroll"
            ></textarea>
          </div>

          <div v-if="parseError" class="message error-message" role="alert">
            <strong>JSON не разобран</strong>
            <span>{{ parseError.message }}</span>
            <code v-if="parseError.line">строка {{ parseError.line }} · столбец {{ parseError.column }}</code>
          </div>
          <div v-else-if="runtimeError" class="message error-message" role="alert">
            <strong>WASM-модуль недоступен</strong>
            <span>{{ runtimeError }}</span>
          </div>

          <footer class="panel-meta">
            <span>{{ inputLines }} строк</span>
            <span>{{ formatBytes(inputBytes) }}</span>
            <span v-if="inputBytes > WARNING_BYTES" class="size-warning">Большой файл</span>
          </footer>
        </section>

        <div class="settings-column">
          <section class="panel settings-panel" aria-labelledby="filter-title">
            <div class="panel-heading compact">
              <div>
                <span class="step-number">02</span>
                <div>
                  <p>Настройка</p>
                  <h2 id="filter-title">Фильтр полей</h2>
                </div>
              </div>
            </div>

            <template v-if="analysis?.array_paths.length">
              <label class="control-label" for="array-path">Массив с объектами</label>
              <div class="select-wrap">
                <select id="array-path" v-model="selectedPath">
                  <option
                    v-for="candidate in analysis.array_paths"
                    :key="candidate.path || '$'"
                    :value="candidate.path"
                  >
                    {{ candidate.label }} · {{ candidate.items }} элементов
                  </option>
                </select>
              </div>

              <div v-if="currentArray" class="array-summary">
                <span><strong>{{ currentArray.items }}</strong> объектов</span>
                <span><strong>{{ currentArray.fields.length }}</strong> полей</span>
                <span v-if="currentArray.skipped_items" class="warning-text">
                  {{ currentArray.skipped_items }} пропущено
                </span>
              </div>

              <div class="field-label-row">
                <span class="control-label">Нужные поля</span>
                <button
                  type="button"
                  class="mini-action"
                  @click="allFieldsSelected ? clearFields() : selectAllFields()"
                >
                  {{ allFieldsSelected ? "Снять все" : "Выбрать все" }}
                </button>
              </div>

              <div v-if="currentArray?.fields.length" class="field-grid">
                <button
                  v-for="field in currentArray.fields"
                  :key="field.name"
                  type="button"
                  class="field-chip"
                  :class="{ selected: selectedFields.includes(field.name) }"
                  :aria-pressed="selectedFields.includes(field.name)"
                  @click="toggleField(field.name)"
                >
                  <span class="checkmark">{{ selectedFields.includes(field.name) ? "✓" : "+" }}</span>
                  <span class="field-name">{{ field.name }}</span>
                  <small>{{ field.kind }}</small>
                </button>
              </div>
              <div v-else class="inline-empty">В объектах этого массива поля не найдены.</div>

              <div v-if="selectedFields.length" class="order-block">
                <span class="control-label">Порядок вывода</span>
                <ol>
                  <li v-for="(field, index) in selectedFields" :key="field">
                    <span class="order-index">{{ index + 1 }}</span>
                    <code>{{ field }}</code>
                    <span class="reorder-buttons">
                      <button
                        type="button"
                        aria-label="Поднять поле"
                        :disabled="index === 0"
                        @click="moveField(index, -1)"
                      >↑</button>
                      <button
                        type="button"
                        aria-label="Опустить поле"
                        :disabled="index === selectedFields.length - 1"
                        @click="moveField(index, 1)"
                      >↓</button>
                    </span>
                  </li>
                </ol>
              </div>
            </template>

            <div v-else-if="analysis" class="panel-empty">
              <span>{ }</span>
              <strong>Массивы не найдены</strong>
              <p>Добавьте массив объектов — например, <code>"stores": [...]</code>.</p>
            </div>
            <div v-else class="panel-empty quiet">
              <span>⌁</span>
              <strong>Ожидаю JSON</strong>
              <p>После разбора здесь появятся массивы и поля.</p>
            </div>
          </section>

          <section class="panel transform-panel" aria-labelledby="transform-title">
            <div class="panel-heading compact">
              <div>
                <span class="step-number accent">03</span>
                <div>
                  <p>Формат результата</p>
                  <h2 id="transform-title">Плоский список</h2>
                </div>
              </div>
            </div>

            <span class="control-label">Разделитель</span>
            <div class="preset-row" aria-label="Готовые разделители">
              <button type="button" :class="{ active: delimiter === ', ' }" @click="delimiter = ', '">
                Запятая
              </button>
              <button type="button" :class="{ active: delimiter === '; ' }" @click="delimiter = '; '">
                Точка с запятой
              </button>
              <button type="button" :class="{ active: delimiter === '\n' }" @click="delimiter = '\n'">
                Новая строка
              </button>
            </div>
            <label class="delimiter-input">
              <span>Свой вариант</span>
              <input v-model="delimiterText" aria-label="Свой разделитель" maxlength="16" />
            </label>

            <div class="toggle-list">
              <label>
                <input v-model="skipEmpty" type="checkbox" />
                <span class="toggle" aria-hidden="true"></span>
                <span><strong>Пропускать пустые</strong><small>null и отсутствующие поля</small></span>
              </label>
              <label>
                <input v-model="unique" type="checkbox" />
                <span class="toggle" aria-hidden="true"></span>
                <span><strong>Только уникальные</strong><small>сохраняется первый порядок</small></span>
              </label>
            </div>

            <div class="order-hint">
              <span aria-hidden="true">↳</span>
              <p>{{ fieldOrderPreview }}</p>
            </div>
          </section>
        </div>

        <section class="panel output-panel" aria-labelledby="output-title">
          <div class="panel-heading">
            <div>
              <span class="step-number accent">04</span>
              <div>
                <p>Готово к использованию</p>
                <h2 id="output-title">Результат</h2>
              </div>
            </div>
            <span v-if="isTransforming" class="working"><i></i> Сборка…</span>
            <span v-else-if="result" class="valid-badge dark">Готово</span>
          </div>

          <div class="output-actions">
            <button
              type="button"
              class="download-button"
              :disabled="!hasOutput"
              @click="downloadOutput"
            >
              Скачать .txt
            </button>
            <button
              type="button"
              class="copy-button"
              :class="{ copied: copyState === 'done' }"
              :disabled="!hasOutput"
              @click="copyOutput"
            >
              {{ copyState === "done" ? "Скопировано ✓" : copyState === "error" ? "Не скопировано" : "Копировать" }}
            </button>
          </div>

          <div class="result-editor" :class="{ empty: !result?.output }">
            <textarea
              v-if="result?.output"
              :value="result.output"
              readonly
              spellcheck="false"
              aria-label="Результат преобразования"
            ></textarea>
            <div v-else class="result-placeholder">
              <span aria-hidden="true">→</span>
              <strong>{{ selectedFields.length ? "Результат появится здесь" : "Выберите поля" }}</strong>
              <p>
                {{ selectedFields.length ? "Rust/WASM обработает данные автоматически." : "Отметьте одно или несколько полей во втором блоке." }}
              </p>
            </div>
          </div>

          <div v-if="transformError" class="message error-message" role="alert">
            <strong>Не удалось преобразовать</strong>
            <span>{{ transformError.message }}</span>
          </div>

          <footer v-if="result" class="result-stats">
            <div><strong>{{ result.source_items }}</strong><span>объектов</span></div>
            <div><strong>{{ result.values }}</strong><span>значений</span></div>
            <div><strong>{{ result.empty_values }}</strong><span>пустых</span></div>
            <div><strong>{{ formatDuration(durationMs) }}</strong><span>обработка</span></div>
          </footer>

          <div class="output-note">
            <span class="wasm-icon" aria-hidden="true">W</span>
            <p><strong>Обработано локально.</strong> Исходный JSON не покидает эту вкладку.</p>
          </div>
        </section>
      </div>

      <footer class="page-footer">
        <p><strong>JSON Rivet</strong> · Vue-интерфейс и Rust/WASM-движок</p>
        <p class="shortcuts"><kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> преобразовать · <kbd>⇧</kbd> + <kbd>⌘/Ctrl</kbd> + <kbd>C</kbd> копировать</p>
      </footer>
    </main>
  </div>
</template>
