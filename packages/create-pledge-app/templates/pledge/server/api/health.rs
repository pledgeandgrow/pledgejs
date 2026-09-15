// Example Rust API route handler.
// PledgePack's adapter-pledgestack scans server/api/*.rs for #[route(...)] macros.

#[route(GET, "/api/health")]
pub async fn health() -> serde_json::Value {
    serde_json::json!({
        "status": "ok",
        "backend": "rust",
    })
}
