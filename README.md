# Peregon

Визуальный конструктор конвейеров данных на Vue 3 с Rust/WebAssembly-движком.
Он объединяет источники, фильтры, выбор полей и преобразование результата в
JSON, CSV, XML, SQL или плоский список.

## Возможности

- форматирование и проверка JSON в Rust;
- автоматический поиск массивов и объединение полей по всем объектам;
- выбор и изменение порядка полей;
- условия фильтрации по полям с логикой «все»/«любое»;
- разделители: запятая, точка с запятой, новая строка или свой вариант;
- пропуск пустых и удаление дублей;
- CSV-подобное экранирование значений;
- копирование и скачивание результата;
- обработка в отдельном Web Worker — данные не покидают браузер.
- собственный инкрементальный syntax engine без внешнего редактора: C#, Rust,
  JavaScript, TypeScript, Python, SQL, JSON, XML, YAML, Java и INI.
- расширяемый registry для собственных языков, валидаторов и форматтеров;
- локальный пересчёт строк после правки, структурная проверка JSON/XML и
  lossless-форматирование JSON.

## Локальный запуск

Требуются Node.js 22+, Rust 1.96 и `wasm-pack`.

```bash
npm install
npm run dev
```

`npm run dev` сначала компилирует crate из `wasm/` в WebAssembly, затем запускает
Vite. Для полной проверки используйте:

```bash
npm test
```

## Архитектура

- `src/` — Vue-интерфейс, клиент фонового процесса и Web Worker;
- [`themoretheless/tokenizer`](https://github.com/themoretheless/tokenizer) —
  отдельный Rust crate `themoretheless-tokenizer`; Peregon фиксирует его по
  релизному Git-тегу и преобразует UTF-8 byte spans в UTF-16 offsets на границе
  WASM;
- `packages/syntax-engine/` — самостоятельный npm-пакет с расширяемым ядром
  токенизации, языковыми профилями, диагностикой и форматтером JSON; публичный
  API описан в
  [`packages/syntax-engine/README.md`](packages/syntax-engine/README.md);
- `wasm/` — Rust-движок анализа и преобразования данных;
- `worker/` — минимальный Cloudflare Worker для раздачи SPA;
- `tests/` — smoke-тест структуры production-сборки.

Архитектурная граница между текущим Rust/WASM runtime и опциональным будущим
DuckDB backend описана в [`docs/runtime-backends.md`](docs/runtime-backends.md).
