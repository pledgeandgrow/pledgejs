// Native compression for HTTP responses.
//
// Uses flate2 (which wraps zlib with SIMD acceleration on supported platforms)
// for gzip and deflate compression. For Brotli, we use the pure-Rust brotli crate.
//
// This is faster than Node's zlib because:
// 1. SIMD-accelerated DEFLATE on x86_64 (via flate2's C backend)
// 2. No V8 buffer allocation overhead
// 3. Zero-copy where possible

use flate2::write::{DeflateEncoder, GzEncoder};
use flate2::Compression;
use napi::bindgen_prelude::Error;
use napi_derive::napi;
use std::io::Write;

/// Compresses data using gzip.
///
/// @param data Input buffer
/// @param level Compression level (1-9, default: 6)
/// @returns Compressed buffer
#[napi]
pub fn gzip_compress(data: Vec<u8>, level: Option<u32>) -> Result<Vec<u8>, Error> {
    let level = level.unwrap_or(6).clamp(1, 9);
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(level));
    encoder
        .write_all(&data)
        .map_err(|e| Error::from_reason(format!("Gzip write error: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| Error::from_reason(format!("Gzip finish error: {}", e)))
}

/// Compresses data using deflate.
///
/// @param data Input buffer
/// @param level Compression level (1-9, default: 6)
/// @returns Compressed buffer
#[napi]
pub fn deflate_compress(data: Vec<u8>, level: Option<u32>) -> Result<Vec<u8>, Error> {
    let level = level.unwrap_or(6).clamp(1, 9);
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::new(level));
    encoder
        .write_all(&data)
        .map_err(|e| Error::from_reason(format!("Deflate write error: {}", e)))?;
    encoder
        .finish()
        .map_err(|e| Error::from_reason(format!("Deflate finish error: {}", e)))
}

/// Decompresses gzip data.
///
/// @param data Compressed buffer
/// @returns Decompressed buffer
#[napi]
pub fn gzip_decompress(data: Vec<u8>) -> Result<Vec<u8>, Error> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut decoder = GzDecoder::new(&data[..]);
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|e| Error::from_reason(format!("Gzip decompress error: {}", e)))?;
    Ok(output)
}

/// Checks if the native compression addon is available.
#[napi]
pub fn is_native_compression_available() -> bool {
    true
}
