use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

#[derive(Debug, Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "snake_case")]
enum FilterMode {
    #[default]
    All,
    Any,
}

#[derive(Debug, Deserialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
enum FilterOperator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterOrEqual,
    LessThan,
    LessOrEqual,
    Contains,
    StartsWith,
    EndsWith,
    Exists,
    NotExists,
}

#[derive(Debug, Deserialize)]
struct FilterCondition {
    field: String,
    operator: FilterOperator,
    #[serde(default)]
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum EngineRequest {
    Analyze {
        json: String,
    },
    Transform {
        json: String,
        path: String,
        fields: Vec<String>,
        delimiter: String,
        skip_empty: bool,
        unique: bool,
        #[serde(default)]
        filters: Vec<FilterCondition>,
        #[serde(default)]
        filter_mode: FilterMode,
    },
}

#[derive(Debug)]
struct ParseProblem {
    message: String,
    line: usize,
    column: usize,
}

#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[wasm_bindgen]
pub fn process_json(request_json: &str) -> String {
    let response = match serde_json::from_str::<EngineRequest>(request_json) {
        Ok(request) => handle_request(request),
        Err(error) => error_response(
            "Не удалось прочитать параметры операции",
            error.line(),
            error.column(),
        ),
    };

    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"ok":false,"error":{"message":"Внутренняя ошибка сериализации","line":0,"column":0}}"#.to_owned()
    })
}

fn handle_request(request: EngineRequest) -> Value {
    match request {
        EngineRequest::Analyze { json } => analyze(&json),
        EngineRequest::Transform {
            json,
            path,
            fields,
            delimiter,
            skip_empty,
            unique,
            filters,
            filter_mode,
        } => transform(
            &json,
            &path,
            &fields,
            &delimiter,
            skip_empty,
            unique,
            &filters,
            filter_mode,
        ),
    }
}

fn parse_json(input: &str) -> Result<Value, ParseProblem> {
    serde_json::from_str(input).map_err(|error| ParseProblem {
        message: error.to_string(),
        line: error.line(),
        column: error.column(),
    })
}

fn analyze(input: &str) -> Value {
    let value = match parse_json(input) {
        Ok(value) => value,
        Err(problem) => {
            return error_response(
                &format!("Некорректный JSON: {}", problem.message),
                problem.line,
                problem.column,
            )
        }
    };

    let mut arrays = Vec::new();
    collect_arrays(&value, "", "$", &mut arrays);

    json!({
        "ok": true,
        "formatted_json": serde_json::to_string_pretty(&value).unwrap_or_else(|_| input.to_owned()),
        "root_type": value_kind(&value),
        "array_paths": arrays,
    })
}

fn collect_arrays(value: &Value, pointer: &str, label: &str, output: &mut Vec<Value>) {
    match value {
        Value::Array(items) => {
            output.push(array_info(items, pointer, label));
        }
        Value::Object(object) => {
            for (key, child) in object {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                let next_pointer = format!("{pointer}/{escaped}");
                let next_label = if label == "$" {
                    key.to_owned()
                } else {
                    format!("{label}.{key}")
                };
                collect_arrays(child, &next_pointer, &next_label, output);
            }
        }
        _ => {}
    }
}

fn array_info(items: &[Value], pointer: &str, label: &str) -> Value {
    let mut fields: Vec<(String, String, usize)> = Vec::new();
    let mut object_items = 0usize;

    for item in items {
        let Value::Object(object) = item else {
            continue;
        };
        object_items += 1;

        for (name, value) in object {
            if let Some(existing) = fields.iter_mut().find(|field| field.0 == *name) {
                existing.2 += 1;
                let next_kind = value_kind(value).to_owned();
                if existing.1 == "null" && next_kind != "null" {
                    existing.1 = next_kind;
                } else if next_kind != "null" && existing.1 != next_kind {
                    existing.1 = "mixed".to_owned();
                }
            } else {
                fields.push((name.to_owned(), value_kind(value).to_owned(), 1));
            }
        }
    }

    let field_values: Vec<Value> = fields
        .into_iter()
        .map(|(name, kind, present)| {
            json!({
                "name": name,
                "kind": kind,
                "present": present,
            })
        })
        .collect();

    json!({
        "path": pointer,
        "label": label,
        "items": items.len(),
        "object_items": object_items,
        "skipped_items": items.len().saturating_sub(object_items),
        "fields": field_values,
    })
}

fn transform(
    input: &str,
    path: &str,
    fields: &[String],
    delimiter: &str,
    skip_empty: bool,
    unique: bool,
    filters: &[FilterCondition],
    filter_mode: FilterMode,
) -> Value {
    let value = match parse_json(input) {
        Ok(value) => value,
        Err(problem) => {
            return error_response(
                &format!("Некорректный JSON: {}", problem.message),
                problem.line,
                problem.column,
            )
        }
    };

    let selected = if path.is_empty() {
        &value
    } else {
        match value.pointer(path) {
            Some(selected) => selected,
            None => {
                return error_response("Выбранный путь больше не существует", 0, 0);
            }
        }
    };

    let Value::Array(items) = selected else {
        return error_response("По выбранному пути находится не массив", 0, 0);
    };

    let mut values = Vec::new();
    let mut seen = HashSet::new();
    let mut object_items = 0usize;
    let mut matched_items = 0usize;
    let mut filtered_out = 0usize;
    let mut skipped_items = 0usize;
    let mut empty_values = 0usize;

    for item in items {
        let Value::Object(object) = item else {
            skipped_items += 1;
            continue;
        };
        object_items += 1;

        if !matches_filters(object, filters, filter_mode) {
            filtered_out += 1;
            continue;
        }
        matched_items += 1;

        for field in fields {
            match object.get(field) {
                Some(Value::Null) | None => {
                    empty_values += 1;
                    if !skip_empty {
                        push_value(String::new(), delimiter, unique, &mut seen, &mut values);
                    }
                }
                Some(value) => {
                    let raw = value_to_text(value);
                    if raw.is_empty() && skip_empty {
                        empty_values += 1;
                    } else {
                        push_value(raw, delimiter, unique, &mut seen, &mut values);
                    }
                }
            }
        }
    }

    json!({
        "ok": true,
        "output": values.join(delimiter),
        "source_items": items.len(),
        "object_items": object_items,
        "matched_items": matched_items,
        "filtered_out": filtered_out,
        "skipped_items": skipped_items,
        "empty_values": empty_values,
        "values": values.len(),
    })
}

fn matches_filters(
    object: &Map<String, Value>,
    filters: &[FilterCondition],
    mode: FilterMode,
) -> bool {
    if filters.is_empty() {
        return true;
    }

    match mode {
        FilterMode::All => filters
            .iter()
            .all(|condition| matches_condition(object, condition)),
        FilterMode::Any => filters
            .iter()
            .any(|condition| matches_condition(object, condition)),
    }
}

fn matches_condition(object: &Map<String, Value>, condition: &FilterCondition) -> bool {
    let actual = object.get(&condition.field);

    match condition.operator {
        FilterOperator::Exists => actual.is_some(),
        FilterOperator::NotExists => actual.is_none(),
        FilterOperator::Equal => actual
            .and_then(|value| values_equal(value, &condition.value))
            .unwrap_or(false),
        FilterOperator::NotEqual => actual
            .and_then(|value| values_equal(value, &condition.value))
            .map(|is_equal| !is_equal)
            .unwrap_or(false),
        FilterOperator::GreaterThan => compare_value(actual, &condition.value)
            .map(|ordering| ordering == Ordering::Greater)
            .unwrap_or(false),
        FilterOperator::GreaterOrEqual => compare_value(actual, &condition.value)
            .map(|ordering| matches!(ordering, Ordering::Greater | Ordering::Equal))
            .unwrap_or(false),
        FilterOperator::LessThan => compare_value(actual, &condition.value)
            .map(|ordering| ordering == Ordering::Less)
            .unwrap_or(false),
        FilterOperator::LessOrEqual => compare_value(actual, &condition.value)
            .map(|ordering| matches!(ordering, Ordering::Less | Ordering::Equal))
            .unwrap_or(false),
        FilterOperator::Contains => actual
            .map(|value| filter_text(value).contains(&expected_string(&condition.value)))
            .unwrap_or(false),
        FilterOperator::StartsWith => actual
            .map(|value| filter_text(value).starts_with(&expected_string(&condition.value)))
            .unwrap_or(false),
        FilterOperator::EndsWith => actual
            .map(|value| filter_text(value).ends_with(&expected_string(&condition.value)))
            .unwrap_or(false),
    }
}

fn values_equal(actual: &Value, expected: &str) -> Option<bool> {
    match actual {
        Value::String(value) => Some(value == &expected_string(expected)),
        Value::Number(value) => {
            compare_numbers(value, expected).map(|ordering| ordering == Ordering::Equal)
        }
        Value::Bool(value) => expected
            .trim()
            .parse::<bool>()
            .ok()
            .map(|expected_bool| *value == expected_bool),
        Value::Null => Some(expected.trim().eq_ignore_ascii_case("null")),
        Value::Array(_) | Value::Object(_) => serde_json::from_str::<Value>(expected.trim())
            .ok()
            .map(|expected_value| actual == &expected_value),
    }
}

fn compare_value(actual: Option<&Value>, expected: &str) -> Option<Ordering> {
    match actual? {
        Value::Number(value) => compare_numbers(value, expected),
        Value::String(value) => Some(value.as_str().cmp(expected_string(expected).as_str())),
        Value::Bool(value) => Some(value.cmp(&expected.trim().parse::<bool>().ok()?)),
        _ => None,
    }
}

fn compare_numbers(actual: &serde_json::Number, expected: &str) -> Option<Ordering> {
    let Value::Number(expected) = serde_json::from_str::<Value>(expected.trim()).ok()? else {
        return None;
    };

    if let (Some(actual), Some(expected)) = (actual.as_i64(), expected.as_i64()) {
        return Some(actual.cmp(&expected));
    }
    if let (Some(actual), Some(expected)) = (actual.as_u64(), expected.as_u64()) {
        return Some(actual.cmp(&expected));
    }
    if let (Some(actual), Some(expected)) = (actual.as_i64(), expected.as_u64()) {
        return Some(if actual < 0 {
            Ordering::Less
        } else {
            (actual as u64).cmp(&expected)
        });
    }
    if let (Some(actual), Some(expected)) = (actual.as_u64(), expected.as_i64()) {
        return Some(if expected < 0 {
            Ordering::Greater
        } else {
            actual.cmp(&(expected as u64))
        });
    }

    actual.as_f64()?.partial_cmp(&expected.as_f64()?)
}

fn expected_string(value: &str) -> String {
    value.to_owned()
}

fn filter_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_owned(),
        _ => value_to_text(value),
    }
}

fn push_value(
    raw: String,
    delimiter: &str,
    unique: bool,
    seen: &mut HashSet<String>,
    values: &mut Vec<String>,
) {
    if unique && !seen.insert(raw.clone()) {
        return;
    }
    values.push(escape_value(&raw, delimiter));
}

fn value_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_owned(),
        Value::Number(number) => number.to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| String::new())
        }
    }
}

fn escape_value(value: &str, delimiter: &str) -> String {
    let needs_quotes = value.contains('"')
        || value.contains('\n')
        || value.contains('\r')
        || (!delimiter.is_empty() && value.contains(delimiter));

    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn error_response(message: &str, line: usize, column: usize) -> Value {
    json!({
        "ok": false,
        "error": {
            "message": message,
            "line": line,
            "column": column,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
        "stores": [
            {"id":"A1","name":"Москва 4-10","state":1},
            {"id":"B2","name":"Белгород-2","state":1}
        ]
    }"#;

    fn request(value: Value) -> Value {
        serde_json::from_str(&process_json(&value.to_string())).unwrap()
    }

    #[test]
    fn discovers_array_and_union_of_fields() {
        let result = request(json!({"action": "analyze", "json": SAMPLE}));
        assert_eq!(result["ok"], true);
        assert_eq!(result["array_paths"][0]["path"], "/stores");
        assert_eq!(result["array_paths"][0]["items"], 2);
        assert_eq!(result["array_paths"][0]["fields"][1]["name"], "name");
    }

    #[test]
    fn flattens_a_selected_field() {
        let result = request(json!({
            "action": "transform",
            "json": SAMPLE,
            "path": "/stores",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false
        }));
        assert_eq!(result["output"], "Москва 4-10, Белгород-2");
        assert_eq!(result["values"], 2);
        assert_eq!(result["source_items"], 2);
        assert_eq!(result["object_items"], 2);
        assert_eq!(result["matched_items"], 2);
        assert_eq!(result["filtered_out"], 0);
        assert_eq!(result["skipped_items"], 0);
    }

    #[test]
    fn preserves_item_then_field_order() {
        let result = request(json!({
            "action": "transform",
            "json": SAMPLE,
            "path": "/stores",
            "fields": ["id", "name"],
            "delimiter": " | ",
            "skip_empty": true,
            "unique": false
        }));
        assert_eq!(result["output"], "A1 | Москва 4-10 | B2 | Белгород-2");
    }

    #[test]
    fn skips_nulls_and_deduplicates() {
        let input = r#"[{"x":"one"},{"x":null},{"x":"one"},{"x":"two"}]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["x"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": true
        }));
        assert_eq!(result["output"], "one, two");
        assert_eq!(result["empty_values"], 1);
    }

    #[test]
    fn reports_invalid_json_location() {
        let result = request(json!({"action": "analyze", "json": "{\"x\": ]"}));
        assert_eq!(result["ok"], false);
        assert!(result["error"]["line"].as_u64().unwrap() > 0);
        assert!(result["error"]["column"].as_u64().unwrap() > 0);
    }

    #[test]
    fn quotes_values_that_collide_with_separator() {
        let input = r#"[{"x":"a, b"},{"x":"say \"hi\""}]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["x"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false
        }));
        assert_eq!(result["output"], "\"a, b\", \"say \"\"hi\"\"\"");
    }

    #[test]
    fn filters_numeric_fields_before_flattening() {
        let input = r#"[
            {"name":"Активный","state":1},
            {"name":"Скрытый","state":0},
            {"name":"Без статуса"}
        ]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"state","operator":"equal","value":"1"}],
            "filter_mode": "all"
        }));
        assert_eq!(result["output"], "Активный");
        assert_eq!(result["matched_items"], 1);
        assert_eq!(result["filtered_out"], 2);
    }

    #[test]
    fn combines_conditions_with_any_mode() {
        let input = r#"[
            {"name":"Москва","state":1,"locality":"Москва"},
            {"name":"Белгород","state":0,"locality":"Белгород"},
            {"name":"Курск","state":0,"locality":"Курск"}
        ]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [
                {"field":"state","operator":"equal","value":"1"},
                {"field":"locality","operator":"contains","value":"город"}
            ],
            "filter_mode": "any"
        }));
        assert_eq!(result["output"], "Москва, Белгород");
        assert_eq!(result["matched_items"], 2);
    }

    #[test]
    fn distinguishes_present_null_from_missing() {
        let input = r#"[{"name":"null","x":null},{"name":"missing"}]"#;
        let exists = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"x","operator":"exists"}],
            "filter_mode": "all"
        }));
        let missing = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"x","operator":"not_exists"}],
            "filter_mode": "all"
        }));
        assert_eq!(exists["output"], "null");
        assert_eq!(missing["output"], "missing");
    }

    #[test]
    fn missing_field_does_not_match_not_equal() {
        let input = r#"[{"name":"zero","state":0},{"name":"missing"}]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["name"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"state","operator":"not_equal","value":"1"}],
            "filter_mode": "all"
        }));
        assert_eq!(result["output"], "zero");
        assert_eq!(result["matched_items"], 1);
    }

    #[test]
    fn filtering_happens_before_empty_and_value_accounting() {
        let input = r#"[
            {"id":"keep-1","status":"open","payload":null},
            17,
            {"id":"drop","status":"closed"},
            {"id":"keep-2","status":"open"}
        ]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["id", "payload"],
            "delimiter": " | ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"status","operator":"equal","value":"open"}],
            "filter_mode": "all"
        }));
        assert_eq!(result["output"], "keep-1 | keep-2");
        assert_eq!(result["source_items"], 4);
        assert_eq!(result["object_items"], 3);
        assert_eq!(result["matched_items"], 2);
        assert_eq!(result["filtered_out"], 1);
        assert_eq!(result["skipped_items"], 1);
        assert_eq!(result["empty_values"], 2);
        assert_eq!(result["values"], 2);
    }

    #[test]
    fn preserves_large_integer_precision() {
        let input = r#"[
            {"id":"exact","n":9007199254740993},
            {"id":"adjacent","n":9007199254740992}
        ]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["id"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{
                "field":"n",
                "operator":"equal",
                "value":"9007199254740993"
            }],
            "filter_mode": "all"
        }));
        assert_eq!(result["output"], "exact");
        assert_eq!(result["matched_items"], 1);
    }

    #[test]
    fn invalid_numeric_operand_never_broad_matches() {
        let input = r#"[{"id":"one","state":1},{"id":"zero","state":0}]"#;
        let result = request(json!({
            "action": "transform",
            "json": input,
            "path": "",
            "fields": ["id"],
            "delimiter": ", ",
            "skip_empty": true,
            "unique": false,
            "filters": [{"field":"state","operator":"not_equal","value":"abc"}],
            "filter_mode": "all"
        }));
        assert_eq!(result["output"], "");
        assert_eq!(result["matched_items"], 0);
        assert_eq!(result["filtered_out"], 2);
    }
}
