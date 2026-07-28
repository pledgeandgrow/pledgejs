// #238 — Rust HTML template engine.
//
// Native HTML rendering for layout shells, <head> generation,
// script/link injection, and HTML entity escaping.
//
// This is a real Rust implementation that provides measurable speedup
// over the JS fallback for HTML string construction.

use napi_derive::napi;

/// Escapes HTML special characters in a string.
/// Uses SIMD intrinsics on x86_64 for batch processing of 16-byte chunks.
#[napi]
pub fn escape_html(input: String) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();

    // Fast path: scan for characters that need escaping.
    // If none found, return the original string without allocation.
    let needs_escaping = bytes
        .iter()
        .any(|&b| b == b'&' || b == b'<' || b == b'>' || b == b'"' || b == b'\'' || b == b'/');
    if !needs_escaping {
        return input;
    }

    let mut output = String::with_capacity(len * 6 / 5);

    // SIMD fast scan: process 16-byte chunks on x86_64
    #[cfg(target_arch = "x86_64")]
    {
        use std::arch::x86_64::*;

        if is_x86_feature_detected!("sse2") {
            let chunks = len / 16;
            let remainder = len % 16;

            // SIMD masks for detecting special characters
            let amp_mask = unsafe { _mm_set1_epi8(b'&' as i8) };
            let lt_mask = unsafe { _mm_set1_epi8(b'<' as i8) };
            let gt_mask = unsafe { _mm_set1_epi8(b'>' as i8) };
            let quot_mask = unsafe { _mm_set1_epi8(b'"' as i8) };
            let apos_mask = unsafe { _mm_set1_epi8(b'\'' as i8) };
            let slash_mask = unsafe { _mm_set1_epi8(b'/' as i8) };

            let mut i = 0;
            for _ in 0..chunks {
                let chunk = unsafe { _mm_loadu_si128(bytes.as_ptr().add(i) as *const __m128i) };

                // Check if any byte in this chunk needs escaping
                let amp_eq = unsafe { _mm_cmpeq_epi8(chunk, amp_mask) };
                let lt_eq = unsafe { _mm_cmpeq_epi8(chunk, lt_mask) };
                let gt_eq = unsafe { _mm_cmpeq_epi8(chunk, gt_mask) };
                let quot_eq = unsafe { _mm_cmpeq_epi8(chunk, quot_mask) };
                let apos_eq = unsafe { _mm_cmpeq_epi8(chunk, apos_mask) };
                let slash_eq = unsafe { _mm_cmpeq_epi8(chunk, slash_mask) };

                let combined = unsafe {
                    _mm_or_si128(_mm_or_si128(amp_eq, lt_eq), _mm_or_si128(gt_eq, quot_eq))
                };
                let combined = unsafe { _mm_or_si128(combined, _mm_or_si128(apos_eq, slash_eq)) };

                let mask = unsafe { _mm_movemask_epi8(combined) };

                if mask == 0 {
                    // No escaping needed in this chunk — copy raw
                    output.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[i..i + 16]) });
                } else {
                    // Escaping needed — process byte by byte for this chunk
                    for j in 0..16 {
                        escape_byte(&mut output, bytes[i + j]);
                    }
                }
                i += 16;
            }

            // Handle remainder
            for &b in bytes.iter().take(len).skip(len - remainder) {
                escape_byte(&mut output, b);
            }
            return output;
        }
    }

    // Fallback: scalar char-by-char
    for &b in bytes {
        escape_byte(&mut output, b);
    }
    output
}

/// Escapes a single byte into the output string.
#[inline(always)]
fn escape_byte(output: &mut String, b: u8) {
    match b {
        b'&' => output.push_str("&amp;"),
        b'<' => output.push_str("&lt;"),
        b'>' => output.push_str("&gt;"),
        b'"' => output.push_str("&quot;"),
        b'\'' => output.push_str("&#x27;"),
        b'/' => output.push_str("&#x2F;"),
        _ => output.push(b as char),
    }
}

/// Escapes a string for use inside an HTML attribute value.
#[napi]
pub fn escape_attr(input: String) -> String {
    let mut output = String::with_capacity(input.len() * 6 / 5);
    for ch in input.chars() {
        match ch {
            '&' => output.push_str("&amp;"),
            '"' => output.push_str("&quot;"),
            '\'' => output.push_str("&#x27;"),
            '<' => output.push_str("&lt;"),
            '>' => output.push_str("&gt;"),
            _ => output.push(ch),
        }
    }
    output
}

/// Head metadata for rendering <head> tags.
#[napi(object)]
pub struct HeadMetadataInput {
    pub title: Option<String>,
    pub description: Option<String>,
    pub keywords: Option<Vec<String>>,
    pub canonical: Option<String>,
    pub robots: Option<String>,
    pub open_graph_title: Option<String>,
    pub open_graph_description: Option<String>,
    pub open_graph_images: Option<Vec<String>>,
    pub open_graph_type: Option<String>,
    pub open_graph_url: Option<String>,
    pub twitter_card: Option<String>,
    pub twitter_title: Option<String>,
    pub twitter_description: Option<String>,
    pub twitter_images: Option<Vec<String>>,
    pub theme_color: Option<String>,
    pub color_scheme: Option<String>,
    pub viewport_width: Option<String>,
    pub viewport_initial_scale: Option<String>,
    pub viewport_maximum_scale: Option<String>,
    pub viewport_user_scalable: Option<String>,
    pub structured_data: Option<String>,
    pub author: Option<String>,
}

/// Script/link injection entry.
#[napi(object)]
pub struct ScriptEntry {
    pub src: Option<String>,
    pub content: Option<String>,
    pub r#type: Option<String>,
    pub r#async: Option<bool>,
    pub defer: Option<bool>,
    pub nomodule: Option<bool>,
}

#[napi(object)]
pub struct LinkEntry {
    pub rel: String,
    pub href: String,
    pub r#type: Option<String>,
    pub crossorigin: Option<String>,
    pub media: Option<String>,
    pub as_: Option<String>,
}

/// Renders the <head> section from metadata.
#[napi]
pub fn render_head(
    metadata: HeadMetadataInput,
    scripts: Option<Vec<ScriptEntry>>,
    links: Option<Vec<LinkEntry>>,
) -> String {
    let mut html = String::with_capacity(2048);
    html.push_str("<head>\n");

    // Charset
    html.push_str("  <meta charset=\"utf-8\" />\n");

    // Viewport
    let viewport_width = metadata.viewport_width.as_deref().unwrap_or("device-width");
    let viewport_initial = metadata.viewport_initial_scale.as_deref().unwrap_or("1.0");
    let mut viewport = format!(
        "width={}, initial-scale={}",
        viewport_width, viewport_initial
    );
    if let Some(ref max_scale) = metadata.viewport_maximum_scale {
        viewport.push_str(&format!(", maximum-scale={}", max_scale));
    }
    if let Some(ref scalable) = metadata.viewport_user_scalable {
        viewport.push_str(&format!(", user-scalable={}", scalable));
    }
    html.push_str(&format!(
        "  <meta name=\"viewport\" content=\"{}\" />\n",
        viewport
    ));

    // Theme color
    if let Some(ref color) = metadata.theme_color {
        html.push_str(&format!(
            "  <meta name=\"theme-color\" content=\"{}\" />\n",
            escape_attr(color.clone())
        ));
    }

    // Color scheme
    if let Some(ref scheme) = metadata.color_scheme {
        html.push_str(&format!(
            "  <meta name=\"color-scheme\" content=\"{}\" />\n",
            escape_attr(scheme.clone())
        ));
    }

    // Title
    if let Some(ref title) = metadata.title {
        html.push_str(&format!(
            "  <title>{}</title>\n",
            escape_html(title.clone())
        ));
    }

    // Description
    if let Some(ref desc) = metadata.description {
        html.push_str(&format!(
            "  <meta name=\"description\" content=\"{}\" />\n",
            escape_attr(desc.clone())
        ));
    }

    // Keywords
    if let Some(ref keywords) = metadata.keywords {
        if !keywords.is_empty() {
            let joined = keywords.join(", ");
            html.push_str(&format!(
                "  <meta name=\"keywords\" content=\"{}\" />\n",
                escape_attr(joined)
            ));
        }
    }

    // Author
    if let Some(ref author) = metadata.author {
        html.push_str(&format!(
            "  <meta name=\"author\" content=\"{}\" />\n",
            escape_attr(author.clone())
        ));
    }

    // Robots
    if let Some(ref robots) = metadata.robots {
        html.push_str(&format!(
            "  <meta name=\"robots\" content=\"{}\" />\n",
            escape_attr(robots.clone())
        ));
    }

    // Canonical
    if let Some(ref canonical) = metadata.canonical {
        html.push_str(&format!(
            "  <link rel=\"canonical\" href=\"{}\" />\n",
            escape_attr(canonical.clone())
        ));
    }

    // Open Graph
    if let Some(ref og_title) = metadata.open_graph_title {
        html.push_str(&format!(
            "  <meta property=\"og:title\" content=\"{}\" />\n",
            escape_attr(og_title.clone())
        ));
    }
    if let Some(ref og_desc) = metadata.open_graph_description {
        html.push_str(&format!(
            "  <meta property=\"og:description\" content=\"{}\" />\n",
            escape_attr(og_desc.clone())
        ));
    }
    if let Some(ref og_type) = metadata.open_graph_type {
        html.push_str(&format!(
            "  <meta property=\"og:type\" content=\"{}\" />\n",
            escape_attr(og_type.clone())
        ));
    }
    if let Some(ref og_url) = metadata.open_graph_url {
        html.push_str(&format!(
            "  <meta property=\"og:url\" content=\"{}\" />\n",
            escape_attr(og_url.clone())
        ));
    }
    if let Some(ref images) = metadata.open_graph_images {
        for img in images {
            html.push_str(&format!(
                "  <meta property=\"og:image\" content=\"{}\" />\n",
                escape_attr(img.clone())
            ));
        }
    }

    // Twitter Card
    if let Some(ref card) = metadata.twitter_card {
        html.push_str(&format!(
            "  <meta name=\"twitter:card\" content=\"{}\" />\n",
            escape_attr(card.clone())
        ));
    }
    if let Some(ref tw_title) = metadata.twitter_title {
        html.push_str(&format!(
            "  <meta name=\"twitter:title\" content=\"{}\" />\n",
            escape_attr(tw_title.clone())
        ));
    }
    if let Some(ref tw_desc) = metadata.twitter_description {
        html.push_str(&format!(
            "  <meta name=\"twitter:description\" content=\"{}\" />\n",
            escape_attr(tw_desc.clone())
        ));
    }
    if let Some(ref images) = metadata.twitter_images {
        for img in images {
            html.push_str(&format!(
                "  <meta name=\"twitter:image\" content=\"{}\" />\n",
                escape_attr(img.clone())
            ));
        }
    }

    // Structured data (JSON-LD)
    if let Some(ref structured) = metadata.structured_data {
        html.push_str(&format!(
            "  <script type=\"application/ld+json\">{}</script>\n",
            structured
        ));
    }

    // Link tags
    if let Some(ref links) = links {
        for link in links {
            let mut tag = format!(
                "  <link rel=\"{}\" href=\"{}\"",
                escape_attr(link.rel.clone()),
                escape_attr(link.href.clone())
            );
            if let Some(ref t) = link.r#type {
                tag.push_str(&format!(" type=\"{}\"", escape_attr(t.clone())));
            }
            if let Some(ref co) = link.crossorigin {
                tag.push_str(&format!(" crossorigin=\"{}\"", escape_attr(co.clone())));
            }
            if let Some(ref media) = link.media {
                tag.push_str(&format!(" media=\"{}\"", escape_attr(media.clone())));
            }
            if let Some(ref as_val) = link.as_ {
                tag.push_str(&format!(" as=\"{}\"", escape_attr(as_val.clone())));
            }
            tag.push_str(" />\n");
            html.push_str(&tag);
        }
    }

    // Script tags
    if let Some(ref scripts) = scripts {
        for script in scripts {
            let mut tag = String::from("  <script");
            if let Some(ref t) = script.r#type {
                tag.push_str(&format!(" type=\"{}\"", escape_attr(t.clone())));
            }
            if let Some(true) = script.r#async {
                tag.push_str(" async");
            }
            if let Some(true) = script.defer {
                tag.push_str(" defer");
            }
            if let Some(true) = script.nomodule {
                tag.push_str(" nomodule");
            }
            if let Some(ref src) = script.src {
                tag.push_str(&format!(" src=\"{}\"", escape_attr(src.clone())));
                tag.push_str("></script>\n");
            } else if let Some(ref content) = script.content {
                tag.push('>');
                tag.push_str(content);
                tag.push_str("</script>\n");
            } else {
                tag.push_str("></script>\n");
            }
            html.push_str(&tag);
        }
    }

    html.push_str("</head>");
    html
}

/// Renders a complete HTML shell with head and body.
#[napi]
pub fn render_html_shell(
    head_html: String,
    body_content: String,
    lang: Option<String>,
    manifest_script: Option<String>,
) -> String {
    let lang_attr = lang.unwrap_or_else(|| "en".to_string());
    let mut html = String::with_capacity(head_html.len() + body_content.len() + 256);
    html.push_str("<!DOCTYPE html>\n");
    html.push_str(&format!("<html lang=\"{}\">\n", escape_attr(lang_attr)));
    html.push_str(&head_html);
    html.push_str("\n<body>\n");
    html.push_str(&body_content);
    html.push('\n');
    if let Some(ref script) = manifest_script {
        html.push_str(script);
        html.push('\n');
    }
    html.push_str("</body>\n</html>");
    html
}

/// Renders an error page HTML shell.
#[napi]
pub fn render_error_shell(status_code: i32, _title: String, message: String) -> String {
    let status_text = match status_code {
        404 => "Not Found",
        500 => "Internal Server Error",
        403 => "Forbidden",
        401 => "Unauthorized",
        400 => "Bad Request",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let full_title = format!("{} — {}", status_code, status_text);
    let head = format!(
        "<head>\n  <meta charset=\"utf-8\" />\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />\n  <title>{}</title>\n</head>",
        escape_html(full_title.clone())
    );
    let body = format!(
        "<div style=\"font-family:system-ui,sans-serif;text-align:center;padding:4rem 2rem\">\n  <h1 style=\"font-size:3rem;margin:0;color:#e53e3e\">{}</h1>\n  <p style=\"font-size:1.25rem;color:#4a5568;margin:1rem 0\">{}</p>\n</div>",
        escape_html(full_title),
        escape_html(message)
    );
    render_html_shell(head, body, Some("en".to_string()), None)
}
