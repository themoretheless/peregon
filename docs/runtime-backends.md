# Runtime backends

## Решение

`@peregon/syntax-engine` остаётся независимой библиотекой без базы данных,
Vue и runtime-зависимостей. Токенизация, подсветка, диагностика и форматирование
не требуют хранения таблиц или SQL-движка.

Текущий Rust/WebAssembly backend остаётся основным для существующего конвейера:
JSON/CSV → filter/project → экспорт. DuckDB добавляется только как отдельный
опциональный backend, когда графу потребуются реляционные операции:

- `JOIN`, `GROUP BY`, агрегаты, сортировка и window functions;
- выполнение пользовательского SQL;
- чтение Parquet/Arrow и обработка данных, которые не стоит превращать целиком
  в JSON.

## Граница пакетов

- `@peregon/syntax-engine` — только работа с исходным текстом.
- runtime contracts — backend-neutral plan, schema, preview, diagnostics,
  cancellation и непрозрачные ссылки на datasets.
- текущий Rust client — `RustWasmBackend`.
- будущий `@peregon/runtime-duckdb-wasm` — единственный владелец
  `@duckdb/duckdb-wasm`, worker/Wasm assets и SQL-компиляции.

```ts
interface RuntimeBackend {
  readonly id: string;
  supports(plan: ExecutionPlan): boolean;
  execute(plan: ExecutionPlan, signal: AbortSignal): AsyncIterable<NodeResult>;
  preview(ref: RuntimeDatasetRef, limit: number): Promise<RuntimePreview>;
  release(refs: readonly RuntimeDatasetRef[]): Promise<void>;
}
```

`RuntimeDatasetRef` должен дополнительно указывать `backendId` и `sessionId`.
Dataset IDs остаются непрозрачными и не сохраняются в pipeline-файле. Связный
фрагмент плана исполняется одним backend; переход между Rust и DuckDB допустим
только на явной границе данных, предпочтительно через Arrow IPC.

## Browser policy

Для локального privacy-first приложения подходит DuckDB-Wasm, загружаемый
динамически только при первом DuckDB-узле. Assets и extensions должны
раздаваться с того же origin: пользовательские данные не должны требовать CDN
или сетевого сервиса.

Первый вариант остаётся session-scoped и in-memory. OPFS/persistence — отдельная
фаза с политикой quota, очистки, восстановления и миграций. Native DuckDB или
отдельный сервис нужны только для серверных заданий, общего доступа к datasets
или объёмов выше практических браузерных лимитов.

## Состояние

`RuntimeDatasetRef` подключён к Rust backend:

- WASM-движок держит session-scoped хранилище датасетов (content-addressed id,
  LRU, ограничение по памяти) и отдаёт ссылку `{dataset_id, kind, content_hash}`
  в результате каждого успешного узла плана;
- действия `preview_dataset` и `release_datasets` дают bounded-выборку и
  освобождение без повторного выполнения графа;
- `RustWasmBackend` (`src/runtime/rust-backend.ts`) реализует контракт
  `RuntimeBackend` (supports / execute / preview / release) и добавляет к
  ссылкам `backendId` и `sessionId`; ссылки чужого backend или завершённой
  сессии отклоняются;
- инспектор узла загружает через `preview(ref, limit)` до 1000 строк поверх
  встроенного превью в 50 строк;
- после каждого запуска приложение освобождает датасеты, на которые новый
  результат больше не ссылается. Освобождение идёт после прогона, поэтому
  content-addressed id, воспроизведённый обоими запусками, остаётся живым;
  датасеты прогона, вытесненного более новым, забирает LRU движка.

Попадание в кэш плана не пересериализует данные: шаг сначала проверяет, что его
датасет ещё резидентен (`retain`), и регистрирует заново только после
вытеснения.

Каждый узел отчитывается о собственном времени выполнения (`duration_ms` в
wire-статистике, `RuntimeStats.durationMs` в контракте). Часы берутся из
`performance.now()`, привязанного напрямую через `wasm-bindgen`, потому что
`std::time::Instant` компилируется под `wasm32-unknown-unknown`, но падает в
рантайме; нативные тесты используют `Instant`. Измеряется текущий прогон,
поэтому попадание в кэш показывает стоимость подстановки, а не исходного
вычисления. Браузеры огрубляют `performance.now()`, так что короткие шаги
законно дают `0`.

## Следующий шаг

DuckDB имеет смысл проверять отдельным spike `source.parquet →
transform.aggregate → preview`, измерив размер assets, cold start, время
первого preview и peak memory. До появления JOIN/aggregate/SQL/Parquet
устанавливать DuckDB как полноценный второй backend не нужно; существующий
value-vector конвейер остаётся точечным исключением. Будущий
`@peregon/runtime-duckdb-wasm` должен реализовать тот же контракт
`RuntimeBackend` со своим `backendId`.
