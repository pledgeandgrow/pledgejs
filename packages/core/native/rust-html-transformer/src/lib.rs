// #239 — Streaming HTML transformer.
//
// Post-processes SSR output: injects metadata into <head>,
// inserts RSC bootstrap script before </body>, handles backpressure.
//
// Works on chunks of HTML, maintaining state across calls.

use napi_derive::napi;
use std::cell::RefCell;

/// Transform state held across chunks.
pub struct TransformerState {
    /// Buffer for incomplete tags spanning chunk boundaries
    pending: String,
    /// Whether </head> has been seen
    head_closed: bool,
    /// Whether </body> has been seen
    body_closed: bool,
    /// HTML to inject into <head>
    head_injection: String,
    /// HTML to inject before </body>
    body_injection: String,
}

#[napi]
pub struct HtmlTransformer {
    state: RefCell<TransformerState>,
}

#[napi(object)]
pub struct TransformChunkResult {
    pub output: String,
    pub done: bool,
}

#[napi]
impl HtmlTransformer {
    /// Creates a new HTML transformer.
    #[napi(constructor)]
    pub fn new(head_injection: Option<String>, body_injection: Option<String>) -> Self {
        Self {
            state: RefCell::new(TransformerState {
                pending: String::new(),
                head_closed: false,
                body_closed: false,
                head_injection: head_injection.unwrap_or_default(),
                body_injection: body_injection.unwrap_or_default(),
            }),
        }
    }

    /// Transforms a chunk of HTML.
    #[napi]
    pub fn transform_chunk(&self, chunk: String) -> TransformChunkResult {
        let mut state = self.state.borrow_mut();
        let mut input = String::new();
        input.push_str(&state.pending);
        input.push_str(&chunk);
        state.pending.clear();

        let mut output = String::with_capacity(input.len() * 2);

        // Look for </head> to inject head content
        if !state.head_closed && !state.head_injection.is_empty() {
            if let Some(pos) = input.find("</head>") {
                // Inject before </head>
                output.push_str(&input[..pos]);
                output.push_str(&state.head_injection);
                output.push_str(&input[pos..]);
                state.head_closed = true;
            } else if let Some(pos) = input.find("</head") {
                // Partial </head> at end of chunk — buffer it
                let split_point = input.len().saturating_sub(7);
                output.push_str(&input[..split_point.min(pos)]);
                state.pending.push_str(&input[split_point.min(pos)..]);
            } else {
                output.push_str(&input);
            }
        } else if !state.body_closed && !state.body_injection.is_empty() {
            if let Some(pos) = input.find("</body>") {
                output.push_str(&input[..pos]);
                output.push_str(&state.body_injection);
                output.push_str(&input[pos..]);
                state.body_closed = true;
            } else if let Some(pos) = input.find("</body") {
                let split_point = input.len().saturating_sub(7);
                output.push_str(&input[..split_point.min(pos)]);
                state.pending.push_str(&input[split_point.min(pos)..]);
            } else {
                output.push_str(&input);
            }
        } else {
            output.push_str(&input);
        }

        TransformChunkResult {
            output,
            done: state.body_closed,
        }
    }

    /// Flushes any remaining buffered content.
    #[napi]
    pub fn flush(&self) -> String {
        let mut state = self.state.borrow_mut();
        let pending = state.pending.clone();
        state.pending.clear();
        pending
    }
}

/// One-shot HTML transformation (non-streaming).
#[napi]
pub fn transform_html(
    html: String,
    head_injection: Option<String>,
    body_injection: Option<String>,
) -> String {
    let transformer = HtmlTransformer::new(head_injection, body_injection);
    let result = transformer.transform_chunk(html);
    let mut output = result.output;
    output.push_str(&transformer.flush());
    output
}
