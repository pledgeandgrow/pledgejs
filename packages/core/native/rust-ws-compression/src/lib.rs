// Native WebSocket message compression.
//
// Uses flate2 with SIMD acceleration for per-message compression
// (permessage-deflate extension). This reduces bandwidth and CPU
// compared to JS ws library for real-time apps (chat, dashboards).
//
// The JS fallback uses Node's zlib for compression.

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use napi_derive::napi;
use std::io::{Read, Write};

/// Compresses a WebSocket message using permessage-deflate (zlib).
///
/// @param data Message payload
/// @param level Compression level (1-9, default: 6)
/// @returns Compressed payload
#[napi]
pub fn ws_compress(data: Vec<u8>, level: Option<u32>) -> Result<Vec<u8>, String> {
    let level = level.unwrap_or(6).min(9).max(1);
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(level));
    encoder
        .write_all(&data)
        .map_err(|e| format!("WS compress write error: {}", e))?;
    encoder
        .finish()
        .map_err(|e| format!("WS compress finish error: {}", e))
}

/// Decompresses a WebSocket message.
///
/// @param data Compressed payload
/// @returns Original message payload
#[napi]
pub fn ws_decompress(data: Vec<u8>) -> Result<Vec<u8>, String> {
    let mut decoder = ZlibDecoder::new(&data[..]);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|e| format!("WS decompress error: {}", e))?;
    Ok(output)
}

/// Checks if native WebSocket compression is available.
#[napi]
pub fn is_native_ws_compression_available() -> bool {
    true
}
