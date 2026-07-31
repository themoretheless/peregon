use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

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
        } => transform(
            &json,
            &path,
            &fields,
            &delimiter,
            skip_empty,
            unique,
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
    let mut skipped_items = 0usize;
    let mut empty_values = 0usize;

    for item in items {
        let Value::Object(object) = item else {
            skipped_items += 1;
            continue;
        };
        object_items += 1;

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
        "skipped_items": skipped_items,
        "empty_values": empty_values,
        "values": values.len(),
    })
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
}
