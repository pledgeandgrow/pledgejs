// Embedded full-text search engine.
//
// In production, this would use the tantivy crate (a Lucene-equivalent
// full-text search engine written in Rust). For now, we provide a
// simple inverted index implementation that runs embedded — no
// Elasticsearch, no Meilisearch, no external process needed.
//
// The JS fallback uses a simple Map-based inverted index.

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;

struct SearchIndex {
    documents: HashMap<String, String>,
    inverted: HashMap<String, Vec<String>>,
}

static INDEX: Mutex<Option<SearchIndex>> = Mutex::new(None);

fn ensure_index() {
    let mut idx = INDEX.lock().unwrap();
    if idx.is_none() {
        *idx = Some(SearchIndex {
            documents: HashMap::new(),
            inverted: HashMap::new(),
        });
    }
}

/// Adds a document to the search index.
///
/// @param id Document ID
/// @param content Document text content to index
#[napi]
pub fn search_add_document(id: String, content: String) -> Result<(), String> {
    ensure_index();
    let mut idx = INDEX.lock().unwrap();
    let index = idx.as_mut().unwrap();

    // Remove old document from inverted index if it exists
    if let Some(old_content) = index.documents.get(&id) {
        for token in tokenize(old_content) {
            if let Some(doc_ids) = index.inverted.get_mut(&token) {
                doc_ids.retain(|d| d != &id);
            }
        }
    }

    // Add new document
    index.documents.insert(id.clone(), content.clone());

    // Build inverted index
    for token in tokenize(&content) {
        index.inverted.entry(token).or_default().push(id.clone());
    }

    Ok(())
}

/// Removes a document from the search index.
#[napi]
pub fn search_remove_document(id: String) -> Result<(), String> {
    ensure_index();
    let mut idx = INDEX.lock().unwrap();
    let index = idx.as_mut().unwrap();

    if let Some(content) = index.documents.remove(&id) {
        for token in tokenize(&content) {
            if let Some(doc_ids) = index.inverted.get_mut(&token) {
                doc_ids.retain(|d| d != &id);
            }
        }
    }

    Ok(())
}

/// Searches the index for documents matching the query.
///
/// @param query Search query string
/// @param limit Maximum number of results (default: 10)
/// @returns Array of { id, score } sorted by relevance
#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub score: f64,
}

#[napi]
pub fn search_query(query: String, limit: Option<f64>) -> Vec<SearchResult> {
    ensure_index();
    let idx = INDEX.lock().unwrap();
    let index = match idx.as_ref() {
        Some(i) => i,
        None => return vec![],
    };

    let limit = limit.unwrap_or(10.0) as usize;
    let tokens = tokenize(&query);
    let mut scores: HashMap<String, f64> = HashMap::new();

    for token in tokens {
        if let Some(doc_ids) = index.inverted.get(&token) {
            for doc_id in doc_ids {
                *scores.entry(doc_id.clone()).or_insert(0.0) += 1.0;
            }
        }
    }

    let mut results: Vec<SearchResult> = scores
        .into_iter()
        .map(|(id, score)| SearchResult { id, score })
        .collect();

    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(limit);
    results
}

/// Clears the entire search index.
#[napi]
pub fn search_clear() -> Result<(), String> {
    ensure_index();
    let mut idx = INDEX.lock().unwrap();
    let index = idx.as_mut().unwrap();
    index.documents.clear();
    index.inverted.clear();
    Ok(())
}

/// Returns the number of documents in the index.
#[napi]
pub fn search_document_count() -> f64 {
    ensure_index();
    let idx = INDEX.lock().unwrap();
    if let Some(ref index) = *idx {
        index.documents.len() as f64
    } else {
        0.0
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}
