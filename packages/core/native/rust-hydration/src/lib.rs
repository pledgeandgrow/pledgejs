// #245 — Native hydration script generator.
//
// Generates minimal, page-specific hydration scripts.
// Analyzes prerendered HTML for hydration points and produces
// only the JS needed for client-side interactivity.

use napi_derive::napi;
use std::collections::HashSet;

/// Hydration point found in the HTML.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
#[napi(object)]
pub struct HydrationPoint {
    pub selector: String,
    pub component: String,
    pub events: Vec<String>,
    pub chunk_path: Option<String>,
}

/// Result of hydration script generation.
#[napi(object)]
pub struct HydrationScriptResult {
    pub script: String,
    pub used_rust_generator: bool,
    pub size_bytes: i32,
    pub hydration_points: i32,
    pub required_chunks: Vec<String>,
    pub generation_time_us: i64,
}

/// Options for hydration script generation.
#[napi(object)]
pub struct HydrationOptions {
    pub html: String,
    pub mode: Option<String>, // "full" | "minimal" | "progressive"
    pub minify: Option<bool>,
    pub hydration_data: Option<String>,
}

/// Generates a hydration script for a prerendered page.
#[napi]
pub fn generate_hydration_script(options: HydrationOptions) -> HydrationScriptResult {
    let start = std::time::Instant::now();
    let mode = options.mode.as_deref().unwrap_or("full");
    let minify = options.minify.unwrap_or(true);
    let html = &options.html;

    // Find hydration points
    let points = find_hydration_points(html);
    let chunks = find_required_chunks(html);

    let script = match mode {
        "minimal" => generate_minimal(&points, &chunks, minify),
        "progressive" => {
            generate_progressive(&points, &chunks, options.hydration_data.as_deref(), minify)
        }
        _ => generate_full(&points, &chunks, options.hydration_data.as_deref(), minify),
    };

    let size = script.len() as i32;
    let point_count = points.len() as i32;

    HydrationScriptResult {
        script,
        used_rust_generator: true,
        size_bytes: size,
        hydration_points: point_count,
        required_chunks: chunks,
        generation_time_us: start.elapsed().as_micros() as i64,
    }
}

fn find_hydration_points(html: &str) -> Vec<HydrationPoint> {
    let mut points = Vec::new();

    // Find data-pledge-component attributes
    let mut pos = 0;
    while let Some(start) = html[pos..].find("data-pledge-component=\"") {
        let abs_start = pos + start;
        let value_start = abs_start + "data-pledge-component=\"".len();
        if let Some(end) = html[value_start..].find('"') {
            let component = &html[value_start..value_start + end];
            points.push(HydrationPoint {
                selector: format!("[data-pledge-component=\"{}\"]", component),
                component: component.to_string(),
                events: vec!["click".to_string()],
                chunk_path: None,
            });
        }
        pos = value_start;
    }

    // Find data-pledge-interactive attributes
    pos = 0;
    while let Some(start) = html[pos..].find("data-pledge-interactive=\"") {
        let abs_start = pos + start;
        let value_start = abs_start + "data-pledge-interactive=\"".len();
        if let Some(end) = html[value_start..].find('"') {
            let component = &html[value_start..value_start + end];
            points.push(HydrationPoint {
                selector: format!("[data-pledge-interactive=\"{}\"]", component),
                component: component.to_string(),
                events: vec!["click".to_string()],
                chunk_path: None,
            });
        }
        pos = value_start;
    }

    // Find root hydration point
    if html.contains("id=\"__pledge_root__\"") {
        points.push(HydrationPoint {
            selector: "#__pledge_root__".to_string(),
            component: "root".to_string(),
            events: Vec::new(),
            chunk_path: None,
        });
    }

    points
}

fn find_required_chunks(html: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0;
    while let Some(start) = html[pos..].find("data-pledge-chunk=\"") {
        let abs_start = pos + start;
        let value_start = abs_start + "data-pledge-chunk=\"".len();
        if let Some(end) = html[value_start..].find('"') {
            let chunk = &html[value_start..value_start + end];
            if seen.insert(chunk.to_string()) {
                chunks.push(chunk.to_string());
            }
        }
        pos = value_start;
    }
    chunks
}

fn generate_full(
    _points: &[HydrationPoint],
    chunks: &[String],
    hydration_data: Option<&str>,
    minify: bool,
) -> String {
    let chunk_imports: String = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| format!("import * as m{} from \"{}\";", i, c))
        .collect::<Vec<_>>()
        .join("\n");

    let chunk_map: String = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| format!("\"{}\":m{}", c, i))
        .collect::<Vec<_>>()
        .join(",");

    let data_line = hydration_data
        .map(|d| format!("const __pledge_hydration_data__={};", d))
        .unwrap_or_default();

    let script = format!(
        "{chunk_imports}\nconst __pledge_chunks__={{{chunk_map}}};\n{data_line}\nasync function hydrate(){{const{{hydrateRoot}}=await import(\"react-dom/client\");const{{createElement}}=await import(\"react\");const root=document.getElementById(\"__pledge_root__\");if(!root)return;hydrateRoot(root,createElement('div',null,root.innerHTML));}}\nif(document.readyState==='loading'){{document.addEventListener('DOMContentLoaded',hydrate);}}else{{hydrate();}}",
        chunk_imports = chunk_imports,
        chunk_map = chunk_map,
        data_line = data_line
    );

    if minify {
        minify_js(&script)
    } else {
        script
    }
}

fn generate_minimal(points: &[HydrationPoint], chunks: &[String], minify: bool) -> String {
    let bindings: String = points.iter()
        .filter(|p| !p.events.is_empty())
        .map(|p| {
            p.events.iter().map(|ev| {
                format!("document.addEventListener('{}',function(e){{var t=e.target.closest('{}');if(t){{t.dispatchEvent(new CustomEvent('pledge:{}',{{detail:e,bubbles:true}}))}}}})", ev, p.selector, ev)
            }).collect::<Vec<_>>().join(";")
        })
        .collect::<Vec<_>>()
        .join(";");

    let chunk_loader = if !chunks.is_empty() {
        format!("var s={}.map(function(u){{var e=document.createElement('script');e.type='module';e.src=u;document.head.appendChild(e);return e}})", serde_json::to_string(chunks).unwrap_or_default())
    } else {
        String::new()
    };

    let script = format!(
        "(function(){{{chunk_loader}{bindings}}})()",
        chunk_loader = chunk_loader,
        bindings = bindings
    );

    if minify {
        minify_js(&script)
    } else {
        script
    }
}

fn generate_progressive(
    points: &[HydrationPoint],
    chunks: &[String],
    hydration_data: Option<&str>,
    minify: bool,
) -> String {
    let points_json = serde_json::to_string(points).unwrap_or_else(|_| "[]".to_string());
    let chunks_json = serde_json::to_string(chunks).unwrap_or_else(|_| "[]".to_string());

    let hydrate_block = if hydration_data.is_some() {
        "if(document.querySelector('#__pledge_root__')){const{hydrateRoot}=await import('react-dom/client');const{createElement}=await import('react');const root=document.getElementById('__pledge_root__');hydrateRoot(root,createElement('div',{dangerouslySetInnerHTML:{__html:root.innerHTML}}));}"
    } else {
        ""
    };

    let script = format!(
        "(async function(){{var chunks={chunks_json};var loadedChunks=new Map();async function loadChunk(path){{if(loadedChunks.has(path))return loadedChunks.get(path);var mod=await import(path);loadedChunks.set(path,mod);return mod}}var points={points_json};for(var i=0;i<points.length;i++){{var point=points[i];if(point.events.length===0)continue;var els=document.querySelectorAll(point.selector);for(var j=0;j<els.length;j++){{for(var k=0;k<point.events.length;k++){{els[j].addEventListener(point.events[k],async function(e){{if(point.chunkPath){{var mod=await loadChunk(point.chunkPath);if(mod[point.component]){{var handler=mod[point.component];if(typeof handler==='function')handler(e)}}}}}},{{passive:true}})}}}}}}{hydrate_block}}})();",
        chunks_json = chunks_json,
        points_json = points_json,
        hydrate_block = hydrate_block
    );

    if minify {
        minify_js(&script)
    } else {
        script
    }
}

fn minify_js(script: &str) -> String {
    script
        .replace("/\\*[\\s\\S]*?\\*/", "")
        .replace("//[^\n]*", "")
        .replace(r"\s+", " ")
        .replace("; ;", ";")
        .replace("{ ", "{")
        .replace(" }", "}")
        .trim()
        .to_string()
}
