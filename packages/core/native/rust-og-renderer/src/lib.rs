// Native OG image renderer — SVG to PNG rasterization via resvg.
//
// Uses resvg + tiny-skia to rasterize SVG (including foreignObject with HTML)
// to PNG at native speed. This produces real PNG images that social platforms
// (Twitter, Facebook, LinkedIn, Slack) can render, unlike raw SVG which most
// platforms do not support for og:image.
//
// When this addon is not compiled, the JS fallback in og-image-native.ts
// serves the raw SVG (which works in some but not all platforms).

use napi_derive::napi;

/// Renders an SVG string to a PNG buffer.
///
/// @param svg The SVG string to rasterize
/// @param width Target width in pixels (default: 1200)
/// @param height Target height in pixels (default: 630)
/// @return PNG buffer as Vec<u8>
#[napi]
pub fn render_svg_to_png(
    svg: String,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Vec<u8>, String> {
    let w = width.unwrap_or(1200);
    let h = height.unwrap_or(630);

    // Parse the SVG tree
    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|e| format!("SVG parse error: {}", e))?;

    // Create a pixmap (pixel buffer)
    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| format!("Failed to create pixmap {}x{}", w, h))?;

    // Render the SVG tree into the pixmap
    resvg::render(
        &tree,
        usvg::Transform::from_scale(
            w as f32 / tree.size().width() as f32,
            h as f32 / tree.size().height() as f32,
        ),
        &mut pixmap,
    )
    .map_err(|e| format!("SVG render error: {}", e))?;

    // Encode pixmap to PNG
    pixmap
        .encode_png()
        .map_err(|e| format!("PNG encode error: {}", e))
}

/// Renders an SVG string to a WebP buffer (smaller than PNG for OG images).
///
/// @param svg The SVG string to rasterize
/// @param width Target width in pixels (default: 1200)
/// @param height Target height in pixels (default: 630)
/// @param quality WebP quality (1-100, default: 85)
/// @return WebP buffer as Vec<u8>
#[napi]
pub fn render_svg_to_webp(
    svg: String,
    width: Option<u32>,
    height: Option<u32>,
    quality: Option<u32>,
) -> Result<Vec<u8>, String> {
    let w = width.unwrap_or(1200);
    let h = height.unwrap_or(630);
    let q = quality.unwrap_or(85).clamp(1, 100);

    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|e| format!("SVG parse error: {}", e))?;

    let mut pixmap = tiny_skia::Pixmap::new(w, h)
        .ok_or_else(|| format!("Failed to create pixmap {}x{}", w, h))?;

    resvg::render(
        &tree,
        usvg::Transform::from_scale(
            w as f32 / tree.size().width() as f32,
            h as f32 / tree.size().height() as f32,
        ),
        &mut pixmap,
    )
    .map_err(|e| format!("SVG render error: {}", e))?;

    // Encode pixmap to WebP
    pixmap
        .encode_webp()
        .map_err(|e| format!("WebP encode error: {}", e))
}

/// Checks if the native OG renderer is available.
/// Always returns true when this addon is loaded.
#[napi]
pub fn is_native_og_renderer_available() -> bool {
    true
}
