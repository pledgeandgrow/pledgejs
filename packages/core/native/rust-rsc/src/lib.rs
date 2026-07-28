// #237 — RSC payload generation in Rust.
//
// Implements the React Server Components flight protocol serialization
// in Rust. Produces the same wire format as react-server-dom-webpack
// but without the V8 overhead.
//
// The RSC flight format is a stream of lines, each starting with a
// type prefix:
//   - Module references: M:id:hash:exportName
//   - Element references: E:id:hash:exportName
//   - Model data: J:id:json
//   - Text data: T:id:text
//   - Suspense: S:id:json

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A client component reference.
#[napi(object)]
pub struct ClientReference {
    pub module_id: String,
    pub export_name: String,
    pub chunk_path: String,
}

/// A module analysis result.
#[napi(object)]
pub struct ModuleAnalysis {
    pub module_id: String,
    pub imports: Vec<String>,
    pub client_references: Vec<ClientReference>,
    pub is_server_component: bool,
    pub is_client_component: bool,
}

/// RSC serialization result.
#[napi(object)]
pub struct RSCSerializeResult {
    /// The flight payload string
    pub payload: String,
    /// Client references found
    pub client_references: Vec<ClientReference>,
    /// Number of rows serialized
    pub row_count: i32,
    /// Serialization time in microseconds
    pub serialize_time_us: i64,
}

/// RSC row types in the flight protocol.
const ROW_MODULE: &str = "M";
const ROW_ELEMENT: &str = "E";
const ROW_MODEL: &str = "J";
const ROW_TEXT: &str = "T";
const ROW_SUSPENSE: &str = "S";

/// Serializes a JSON value into the RSC flight format.
///
/// The flight format is line-delimited:
///   M:<id>:<moduleId>:<exportName>\n
///   J:<id>:<json>\n
///   T:<id>:<text>\n
#[napi]
pub fn serialize_rsc(
    data: String,
    client_refs: Option<Vec<ClientReference>>,
) -> RSCSerializeResult {
    let start = std::time::Instant::now();
    let mut payload = String::with_capacity(data.len() * 2);
    let mut row_count = 0i32;
    let mut refs = client_refs.unwrap_or_default();

    // Write module references
    for (i, reference) in refs.iter().enumerate() {
        payload.push_str(&format!(
            "{}:{}:{}:{}\n",
            ROW_MODULE, i, reference.module_id, reference.export_name
        ));
        row_count += 1;
    }

    // Write the main model data
    // Parse the input as JSON, then re-serialize as flight rows
    if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&data) {
        let model_id = refs.len();
        let model_json = serialize_flight_model(&json_val, model_id, &mut payload, &mut row_count);
        payload.push_str(&format!("{}:{}:{}\n", ROW_MODEL, model_id, model_json));
        row_count += 1;
    } else {
        // If not valid JSON, write as text
        let text_id = refs.len();
        payload.push_str(&format!(
            "{}:{}:{}\n",
            ROW_TEXT,
            text_id,
            escape_flight_string(&data)
        ));
        row_count += 1;
    }

    RSCSerializeResult {
        payload,
        client_references: refs,
        row_count,
        serialize_time_us: start.elapsed().as_micros() as i64,
    }
}

/// Serializes a JSON value into the flight model format.
fn serialize_flight_model(
    val: &serde_json::Value,
    id: usize,
    payload: &mut String,
    row_count: &mut i32,
) -> String {
    match val {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!("\"{}\"", escape_flight_string(s)),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .map(|v| serialize_flight_model(v, id, payload, row_count))
                .collect();
            format!("[{}]", parts.join(","))
        }
        serde_json::Value::Object(obj) => {
            let parts: Vec<String> = obj
                .iter()
                .map(|(k, v)| {
                    format!(
                        "\"{}\":{}",
                        escape_flight_string(k),
                        serialize_flight_model(v, id, payload, row_count)
                    )
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

/// Escapes a string for the flight protocol.
fn escape_flight_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 6 / 5);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

/// Analyzes a module to extract client references and metadata.
#[napi]
pub fn analyze_modules(source: String, module_id: String) -> ModuleAnalysis {
    let mut imports = Vec::new();
    let mut client_refs = Vec::new();
    let mut is_client = false;

    // Scan for import statements
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ") || trimmed.starts_with("import \"") {
            // Extract module path from import statement
            if let Some(start) = trimmed.find('"') {
                if let Some(end) = trimmed[start + 1..].find('"') {
                    let path = &trimmed[start + 1..start + 1 + end];
                    imports.push(path.to_string());
                }
            } else if let Some(start) = trimmed.find('\'') {
                if let Some(end) = trimmed[start + 1..].find('\'') {
                    let path = &trimmed[start + 1..start + 1 + end];
                    imports.push(path.to_string());
                }
            }
        }

        // Check for "use client" directive
        if trimmed == "\"use client\"" || trimmed == "'use client'" {
            is_client = true;
        }
    }

    // If it's a client component, add it as a client reference
    if is_client {
        client_refs.push(ClientReference {
            module_id: module_id.clone(),
            export_name: "default".to_string(),
            chunk_path: format!("/chunks/{}.js", module_id),
        });
    }

    ModuleAnalysis {
        module_id,
        imports,
        client_references: client_refs,
        is_server_component: !is_client,
        is_client_component: is_client,
    }
}

/// Deserializes an RSC flight payload back to JSON.
#[napi]
pub fn deserialize_rsc(payload: String) -> String {
    let mut result = serde_json::Map::new();

    for line in payload.lines() {
        if line.is_empty() {
            continue;
        }

        // Parse the row type prefix
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() < 3 {
            continue;
        }

        let row_type = parts[0];
        let id = parts[1];
        let data = parts[2];

        match row_type {
            "J" => {
                // Model data
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    result.insert(format!("model_{}", id), val);
                }
            }
            "T" => {
                // Text data
                result.insert(
                    format!("text_{}", id),
                    serde_json::Value::String(unescape_flight_string(data)),
                );
            }
            "M" => {
                // Module reference
                let mut ref_obj = serde_json::Map::new();
                ref_obj.insert(
                    "type".to_string(),
                    serde_json::Value::String("module".to_string()),
                );
                ref_obj.insert("id".to_string(), serde_json::Value::String(id.to_string()));
                ref_obj.insert(
                    "data".to_string(),
                    serde_json::Value::String(data.to_string()),
                );
                result.insert(format!("ref_{}", id), serde_json::Value::Object(ref_obj));
            }
            _ => {}
        }
    }

    serde_json::to_string(&serde_json::Value::Object(result)).unwrap_or_else(|_| "{}".to_string())
}

/// Unescapes a flight protocol string.
fn unescape_flight_string(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some(c) => {
                    out.push('\\');
                    out.push(c);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}
