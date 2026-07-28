// #240 — React DOM string renderer in Rust.
//
// Custom React DOM-to-HTML-string renderer for server-only components.
// Bypasses V8 for pure server rendering with streaming output support.
//
// This renderer accepts a JSON-serialized virtual DOM tree and produces
// HTML strings, handling:
// - Element rendering with attributes
// - Text node escaping
// - Void elements (br, img, input, etc.)
// - Fragment rendering
// - Conditional rendering (null/undefined/boolean)
// - Key filtering (keys are not rendered to HTML)

use napi_derive::napi;
use serde::Deserialize;
use std::collections::HashMap;

/// DOM node representation (JSON-serializable).
#[napi(object)]
pub struct DomNode {
    pub tag: Option<String>,
    pub text: Option<String>,
    pub attrs: Option<HashMap<String, String>>,
    pub children: Option<Vec<DomNode>>,
    pub is_fragment: Option<bool>,
}

/// Render result.
#[napi(object)]
pub struct RenderResult {
    pub html: String,
    pub element_count: i32,
    pub render_time_us: i64,
}

const VOID_ELEMENTS: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

fn is_void(tag: &str) -> bool {
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

fn escape_attr(val: &str) -> String {
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

fn render_node(node: &DomNode, count: &mut i32) -> String {
    *count += 1;
    let mut html = String::new();

    // Text node
    if let Some(ref text) = node.text {
        html.push_str(&escape_text(text));
        return html;
    }

    // Fragment — just render children
    if node.is_fragment.unwrap_or(false) {
        if let Some(ref children) = node.children {
            for child in children {
                html.push_str(&render_node(child, count));
            }
        }
        return html;
    }

    let tag = match node.tag {
        Some(ref t) => t.as_str(),
        None => return html,
    };

    // Open tag
    html.push('<');
    html.push_str(tag);

    // Attributes (skip "key" — it's internal to React)
    if let Some(ref attrs) = node.attrs {
        for (key, value) in attrs {
            if key == "key" {
                continue;
            }
            html.push(' ');
            html.push_str(key);
            html.push_str("=\"");
            html.push_str(&escape_attr(value));
            html.push('"');
        }
    }

    // Void elements
    if is_void(tag) {
        html.push_str(" />");
        return html;
    }

    html.push('>');

    // Children
    if let Some(ref children) = node.children {
        for child in children {
            html.push_str(&render_node(child, count));
        }
    }

    // Close tag
    html.push_str("</");
    html.push_str(tag);
    html.push('>');

    html
}

/// Renders a DOM tree to an HTML string.
#[napi]
pub fn render_to_string(root: DomNode) -> RenderResult {
    let start = std::time::Instant::now();
    let mut count = 0i32;
    let html = render_node(&root, &mut count);
    RenderResult {
        html,
        element_count: count,
        render_time_us: start.elapsed().as_micros() as i64,
    }
}

/// Renders a DOM tree to a chunk of HTML (for streaming).
#[napi]
pub fn render_to_chunk(root: DomNode) -> String {
    let mut count = 0i32;
    render_node(&root, &mut count)
}

/// Checks whether a component tag is safe to render in Rust.
/// Returns false for tags that require client-side interactivity.
#[napi]
pub fn can_render_in_rust(tag: String) -> bool {
    const UNSAFE: &[&str] = &["script", "iframe", "object", "embed", "canvas"];
    !UNSAFE.contains(&tag.as_str())
}
