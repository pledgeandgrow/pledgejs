// PledgeStack server entry point.
// This file is the Rust backend entry. PledgePack's adapter-pledgestack
// discovers routes from server/api/*.rs and server/api/*.psx files.

#[route(GET, "/api/server-info")]
pub async fn server_info() -> serde_json::Value {
    serde_json::json!({
        "runtime": "rust",
        "framework": "pledge",
    })
}
