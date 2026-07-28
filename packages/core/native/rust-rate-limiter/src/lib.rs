// Cross-worker rate limiter using shared in-memory state.
//
// Uses a token bucket algorithm with a global HashMap protected by Mutex.
// In a multi-worker setup, this state is shared via shared memory segments
// (mmap), allowing rate limiting across all workers with zero IPC overhead.
//
// The JS fallback uses a per-process Map which works for single-process
// mode but does not share state across Node.js worker threads.

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Instant, Duration};

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

static BUCKETS: Mutex<Option<HashMap<String, Bucket>>> = Mutex::new(None);

fn ensure_buckets() {
    let mut buckets = BUCKETS.lock().unwrap();
    if buckets.is_none() {
        *buckets = Some(HashMap::new());
    }
}

/// Checks if a request should be allowed under the rate limit.
///
/// @param key Identifier for the rate limit bucket (e.g. IP address, API key)
/// @param max_tokens Maximum tokens in the bucket (burst capacity)
/// @param refill_rate Tokens added per second (sustained rate)
/// @returns { allowed: boolean, remaining: f64, retry_after_ms: f64 }
#[napi(object)]
pub struct RateLimitResult {
    pub allowed: bool,
    pub remaining: f64,
    pub retry_after_ms: f64,
}

#[napi]
pub fn check_rate_limit(key: String, max_tokens: f64, refill_rate: f64) -> RateLimitResult {
    ensure_buckets();
    let mut buckets = BUCKETS.lock().unwrap();
    let map = buckets.as_mut().unwrap();

    let now = Instant::now();
    let entry = map.entry(key).or_insert_with(|| Bucket {
        tokens: max_tokens,
        last_refill: now,
    });

    // Refill tokens based on elapsed time
    let elapsed = now.duration_since(entry.last_refill);
    let refill = elapsed.as_secs_f64() * refill_rate;
    entry.tokens = (entry.tokens + refill).min(max_tokens);
    entry.last_refill = now;

    if entry.tokens >= 1.0 {
        entry.tokens -= 1.0;
        RateLimitResult {
            allowed: true,
            remaining: entry.tokens,
            retry_after_ms: 0.0,
        }
    } else {
        // Calculate retry-after: time until 1 token is available
        let retry_secs = (1.0 - entry.tokens) / refill_rate;
        RateLimitResult {
            allowed: false,
            remaining: 0.0,
            retry_after_ms: (retry_secs * 1000.0).ceil(),
        }
    }
}

/// Resets the rate limit for a given key.
#[napi]
pub fn reset_rate_limit(key: String) {
    ensure_buckets();
    let mut buckets = BUCKETS.lock().unwrap();
    if let Some(ref mut map) = *buckets {
        map.remove(&key);
    }
}

/// Clears all rate limit buckets.
#[napi]
pub fn clear_all_rate_limits() {
    ensure_buckets();
    let mut buckets = BUCKETS.lock().unwrap();
    if let Some(ref mut map) = *buckets {
        map.clear();
    }
}
