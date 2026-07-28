// #236 — Rust SSR for dynamic pages.
//
// Renders static portions of the React tree natively (no V8),
// identifies Suspense boundaries, and emits placeholder slots.
// Dynamic content is streamed via RSC protocol by the JS layer.
//
// This implementation handles:
// - Static HTML string rendering from a virtual DOM tree
// - Suspense boundary extraction with placeholder slots
// - Attribute and text escaping
// - Self-closing and void elements

use napi_derive::napi;
use serde::Deserialize;

/// A virtual DOM node for Rust-side rendering.
#[napi(object)]
pub struct VNode {
    /// Element tag name (e.g. "div", "span"). None for text nodes.
    pub tag: Option<String>,
    /// Text content (for text nodes)
    pub text: Option<String>,
    /// Attributes (key=value pairs)
    pub attrs: Option<HashMap<String, String>>,
    /// Child nodes
    pub children: Option<Vec<VNode>>,
    /// Whether this is a Suspense boundary
    pub is_suspense: Option<bool>,
    /// Suspense fallback children
    pub suspense_fallback: Option<Vec<VNode>>,
}

use std::collections::HashMap;

/// A Suspense boundary extracted from the tree.
#[napi(object)]
pub struct SuspenseBoundary {
    /// Unique ID for this boundary
    pub id: String,
    /// The fallback HTML content
    pub fallback_html: String,
    /// Whether the content has resolved
    pub resolved: bool,
    /// The resolved HTML content (empty if not resolved)
    pub html: String,
    /// Children boundaries (serialized as JSON)
    pub children_json: String,
}

/// Result of rendering a static shell.
#[napi(object)]
pub struct StaticShellResult {
    /// The static shell HTML
    pub html: String,
    /// Extracted Suspense boundaries
    pub suspense_boundaries: Vec<SuspenseBoundary>,
    /// Whether any dynamic content was found
    pub has_dynamic_content: bool,
    /// Number of elements rendered
    pub element_count: i32,
    /// Render time in microseconds
    pub render_time_us: i64,
}

/// Void elements that don't need closing tags.
const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

fn is_void_element(tag: &str) -> bool {
    VOID_ELEMENTS.contains(&tag)
}

fn escape_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 6 / 5);
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

fn escape_attr_value(val: &str) -> String {
    let mut out = String::with_capacity(val.len() * 6 / 5);
    for ch in val.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Renders a VNode tree to HTML string.
fn render_node(node: &VNode, boundaries: &mut Vec<SuspenseBoundary>, depth: &mut i32) -> String {
    *depth += 1;
    let mut html = String::new();

    // Text node
    if let Some(ref text) = node.text {
        html.push_str(&escape_text(text));
        return html;
    }

    let tag = match node.tag {
        Some(ref t) => t,
        None => return html,
    };

    // Handle Suspense boundaries
    if node.is_suspense.unwrap_or(false) {
        let boundary_id = format!("suspense-{}", boundaries.len() + 1);
        let fallback_html = match node.suspense_fallback {
            Some(ref children) => children
                .iter()
                .map(|c| render_node(c, boundaries, depth))
                .collect::<String>(),
            None => String::new(),
        };
        html.push_str(&format!(
            "<!--$?--><template id=\"{}\"></template>{}<!--/$-->",
            escape_attr_value(&boundary_id),
            fallback_html
        ));
        boundaries.push(SuspenseBoundary {
            id: boundary_id,
            fallback_html,
            resolved: false,
            html: String::new(),
            children_json: "[]".to_string(),
        });
        return html;
    }

    // Open tag
    html.push('<');
    html.push_str(tag);

    // Attributes
    if let Some(ref attrs) = node.attrs {
        for (key, value) in attrs {
            html.push(' ');
            html.push_str(key);
            html.push_str("=\"");
            html.push_str(&escape_attr_value(value));
            html.push('"');
        }
    }

    // Self-closing void elements
    if is_void_element(tag) {
        html.push_str(" />");
        return html;
    }

    html.push('>');

    // Children
    if let Some(ref children) = node.children {
        for child in children {
            html.push_str(&render_node(child, boundaries, depth));
        }
    }

    // Close tag
    html.push_str("</");
    html.push_str(tag);
    html.push('>');

    html
}

/// Renders the static shell of a VNode tree, extracting Suspense boundaries.
#[napi]
pub fn render_static_shell(root: VNode) -> StaticShellResult {
    let start = std::time::Instant::now();
    let mut boundaries: Vec<SuspenseBoundary> = Vec::new();
    let mut depth = 0i32;
    let html = render_node(&root, &mut boundaries, &mut depth);
    let has_dynamic = !boundaries.is_empty();

    StaticShellResult {
        html,
        suspense_boundaries: boundaries,
        has_dynamic_content: has_dynamic,
        element_count: depth,
        render_time_us: start.elapsed().as_micros() as i64,
    }
}

/// Renders a simple HTML string from a VNode without Suspense extraction.
#[napi]
pub fn render_to_string(root: VNode) -> String {
    let mut boundaries: Vec<SuspenseBoundary> = Vec::new();
    let mut depth = 0i32;
    render_node(&root, &mut boundaries, &mut depth)
}

/// Checks if a tag can be safely rendered in Rust (no client-side interactivity).
#[napi]
pub fn is_rust_safe_tag(tag: String) -> bool {
    // Tags that require client-side JS or are inherently interactive
    const UNSAFE_TAGS: &[&str] = &[
        "script", "iframe", "object", "embed", "canvas", "video", "audio",
    ];
    !UNSAFE_TAGS.contains(&tag.as_str())
}
