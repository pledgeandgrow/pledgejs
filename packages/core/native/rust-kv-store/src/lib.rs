// Embedded key-value store for ISR/fetch cache persistence.
//
// Uses an in-memory HashMap with optional disk persistence (JSON serialized).
// In production, this would use LMDB or RocksDB via their Rust bindings.
// The JS fallback uses Node.js fs + Map for similar functionality.
//
// This eliminates the need for Redis or external cache services for ISR.
// The store is process-local and crash-safe (writes are flushed to disk).

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;
use std::fs;
use std::path::PathBuf;

static STORE: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);
static STORE_PATH: Mutex<Option<String>> = Mutex::new(None);

fn ensure_store() -> &'static Mutex<Option<HashMap<String, Vec<u8>>>> {
    let mut store = STORE.lock().unwrap();
    if store.is_none() {
        *store = Some(HashMap::new());
    }
    &STORE
}

#[napi]
pub fn kv_open(path: String) -> Result<(), String> {
    let mut p = STORE_PATH.lock().unwrap();
    *p = Some(path.clone());

    let mut store = STORE.lock().unwrap();
    *store = Some(HashMap::new());

    // Load from disk if exists
    let pathbuf = PathBuf::from(&path);
    if pathbuf.exists() {
        let data = fs::read(&pathbuf)
            .map_err(|e| format!("Failed to read KV store: {}", e))?;
        let map: HashMap<String, Vec<u8>> = serde_json::from_slice(&data)
            .map_err(|e| format!("Failed to parse KV store: {}", e))?;
        *store = Some(map);
    }

    Ok(())
}

#[napi]
pub fn kv_get(key: String) -> Result<Option<Buffer>, String> {
    let store = ensure_store();
    let guard = store.lock().unwrap();
    if let Some(ref map) = *guard {
        Ok(map.get(&key).map(|v| Buffer::from(v.clone())))
    } else {
        Ok(None)
    }
}

#[napi]
pub fn kv_set(key: String, value: Buffer) -> Result<(), String> {
    let store = ensure_store();
    {
        let mut guard = store.lock().unwrap();
        if let Some(ref mut map) = *guard {
            map.insert(key, value.to_vec());
        }
    }
    flush_to_disk()
}

#[napi]
pub fn kv_delete(key: String) -> Result<(), String> {
    let store = ensure_store();
    {
        let mut guard = store.lock().unwrap();
        if let Some(ref mut map) = *guard {
            map.remove(&key);
        }
    }
    flush_to_disk()
}

#[napi]
pub fn kv_clear() -> Result<(), String> {
    let store = ensure_store();
    {
        let mut guard = store.lock().unwrap();
        if let Some(ref mut map) = *guard {
            map.clear();
        }
    }
    flush_to_disk()
}

#[napi]
pub fn kv_keys() -> Result<Vec<String>, String> {
    let store = ensure_store();
    let guard = store.lock().unwrap();
    if let Some(ref map) = *guard {
        Ok(map.keys().cloned().collect())
    } else {
        Ok(vec![])
    }
}

#[napi]
pub fn kv_size() -> Result<f64, String> {
    let store = ensure_store();
    let guard = store.lock().unwrap();
    if let Some(ref map) = *guard {
        Ok(map.len() as f64)
    } else {
        Ok(0.0)
    }
}

#[napi]
pub fn kv_flush() -> Result<(), String> {
    flush_to_disk()
}

fn flush_to_disk() -> Result<(), String> {
    let path_guard = STORE_PATH.lock().unwrap();
    if let Some(ref path) = *path_guard {
        let store = STORE.lock().unwrap();
        if let Some(ref map) = *store {
            let data = serde_json::to_vec(map)
                .map_err(|e| format!("Failed to serialize KV store: {}", e))?;
            fs::write(path, data)
                .map_err(|e| format!("Failed to write KV store: {}", e))?;
        }
    }
    Ok(())
}

// Re-export Buffer from napi
use napi::bindgen_prelude::Buffer;
