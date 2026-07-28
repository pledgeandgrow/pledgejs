// #242 — RSC client deserializer in Rust.
//
// Native RSC payload deserialization for edge runtime.
// Parses the flight protocol wire format and produces JSON
// that can be consumed by the client-side React runtime.
//
// Flight format rows:
//   M:<id>:<moduleId>:<exportName>  — module reference
//   E:<id>:<moduleId>:<exportName>  — element reference
//   J:<id>:<json>                    — model data
//   T:<id>:<text>                    — text data
//   S:<id>:<json>                    — suspense boundary

use napi_derive::napi;

/// Deserialized module reference.
#[napi(object)]
pub struct DeserializedModuleRef {
    pub id: String,
    pub module_id: String,
    pub export_name: String,
}

/// Deserialization result.
#[napi(object)]
pub struct DeserializeResult {
    /// The deserialized JSON data
    pub json: String,
    /// Module references found
    pub module_references: Vec<DeserializedModuleRef>,
    /// Number of rows parsed
    pub row_count: i32,
    /// Deserialization time in microseconds
    pub deserialize_time_us: i64,
}

/// Validates an RSC payload and returns whether it's well-formed.
#[napi]
pub fn validate_rsc_payload(payload: String) -> bool {
    for line in payload.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() < 2 {
            return false;
        }
        let row_type = parts[0];
        if !["M", "E", "J", "T", "S"].contains(&row_type) {
            return false;
        }
    }
    true
}

/// Deserializes an RSC flight payload into JSON.
#[napi]
pub fn deserialize(payload: String) -> DeserializeResult {
    let start = std::time::Instant::now();
    let mut result = serde_json::Map::new();
    let mut module_refs = Vec::new();
    let mut row_count = 0i32;

    for line in payload.lines() {
        if line.is_empty() {
            continue;
        }
        row_count += 1;

        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() < 3 {
            continue;
        }

        let row_type = parts[0];
        let id = parts[1];
        let data = parts[2];

        match row_type {
            "M" => {
                // Module reference: M:id:moduleId:exportName
                let sub_parts: Vec<&str> = data.splitn(2, ':').collect();
                let module_id = sub_parts.first().unwrap_or(&"");
                let export_name = sub_parts.get(1).unwrap_or(&"");
                module_refs.push(DeserializedModuleRef {
                    id: id.to_string(),
                    module_id: module_id.to_string(),
                    export_name: export_name.to_string(),
                });
                let mut ref_obj = serde_json::Map::new();
                ref_obj.insert(
                    "type".to_string(),
                    serde_json::Value::String("module".to_string()),
                );
                ref_obj.insert(
                    "moduleId".to_string(),
                    serde_json::Value::String(module_id.to_string()),
                );
                ref_obj.insert(
                    "exportName".to_string(),
                    serde_json::Value::String(export_name.to_string()),
                );
                result.insert(format!("M:{}", id), serde_json::Value::Object(ref_obj));
            }
            "E" => {
                // Element reference: E:id:moduleId:exportName
                let sub_parts: Vec<&str> = data.splitn(2, ':').collect();
                let module_id = sub_parts.first().unwrap_or(&"");
                let export_name = sub_parts.get(1).unwrap_or(&"");
                let mut ref_obj = serde_json::Map::new();
                ref_obj.insert(
                    "type".to_string(),
                    serde_json::Value::String("element".to_string()),
                );
                ref_obj.insert(
                    "moduleId".to_string(),
                    serde_json::Value::String(module_id.to_string()),
                );
                ref_obj.insert(
                    "exportName".to_string(),
                    serde_json::Value::String(export_name.to_string()),
                );
                result.insert(format!("E:{}", id), serde_json::Value::Object(ref_obj));
            }
            "J" => {
                // Model data: J:id:json
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    result.insert(format!("J:{}", id), val);
                }
            }
            "T" => {
                // Text data: T:id:text
                result.insert(
                    format!("T:{}", id),
                    serde_json::Value::String(unescape(data)),
                );
            }
            "S" => {
                // Suspense boundary: S:id:json
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                    result.insert(format!("S:{}", id), val);
                }
            }
            _ => {}
        }
    }

    let json = serde_json::to_string(&serde_json::Value::Object(result))
        .unwrap_or_else(|_| "{}".to_string());

    DeserializeResult {
        json,
        module_references: module_refs,
        row_count,
        deserialize_time_us: start.elapsed().as_micros() as i64,
    }
}

/// Extracts all module references from an RSC payload.
#[napi]
pub fn extract_module_references(payload: String) -> Vec<String> {
    let mut refs = Vec::new();
    for line in payload.lines() {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("M:") || line.starts_with("E:") {
            let parts: Vec<&str> = line.splitn(3, ':').collect();
            if parts.len() >= 3 {
                let sub_parts: Vec<&str> = parts[2].splitn(2, ':').collect();
                if let Some(module_id) = sub_parts.first() {
                    let ref_str =
                        format!("{}:{}", module_id, sub_parts.get(1).unwrap_or(&"default"));
                    if !refs.contains(&ref_str) {
                        refs.push(ref_str);
                    }
                }
            }
        }
    }
    refs
}

fn unescape(s: &str) -> String {
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
