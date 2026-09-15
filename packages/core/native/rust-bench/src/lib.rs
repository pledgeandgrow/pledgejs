// Benchmark addon for `pledge bench --psx`.
//
// Provides a `noop` for measuring raw NAPI boundary overhead plus a small
// set of compute functions with realistic workloads so Rust vs JS numbers
// are meaningful. The CLI discovers every exported #[napi] function and
// benchmarks each; `noop` additionally feeds measureNapiOverhead().

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use serde_json::Value;

/// No-op — measures raw NAPI boundary overhead.
#[napi]
pub fn noop() {}

/// FNV-1a hash over a buffer — cheap, allocation-free workload.
#[napi]
pub fn hash_buffer(data: Buffer) -> u32 {
    let mut hash: u32 = 2166136261;
    for byte in data.as_ref() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash
}

/// Sorts a copy of the input — exercises allocation + comparison.
#[napi]
pub fn sort_numbers(mut numbers: Vec<f64>) -> Vec<f64> {
    numbers.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    numbers
}

/// Repeated string building — exercises allocation churn.
#[napi]
pub fn build_string(parts: u32) -> String {
    let mut out = String::with_capacity((parts as usize) * 8);
    for i in 0..parts {
        out.push_str(&format!("part-{};", i));
    }
    out
}

/// JSON round-trip of the provided payload.
#[napi]
pub fn json_roundtrip(payload: String) -> String {
    let value: Value = serde_json::from_str(&payload)
        .unwrap_or_else(|_| Value::String(payload.clone()));
    serde_json::to_string(&value).unwrap_or(payload)
}

/// Fibonacci (iterative) — pure integer compute.
#[napi]
pub fn fibonacci(n: u32) -> u64 {
    let (mut a, mut b) = (0u64, 1u64);
    for _ in 0..n {
        let next = a.wrapping_add(b);
        a = b;
        b = next;
    }
    a
}
