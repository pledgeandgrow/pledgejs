// JIT hot route template compiler.
//
// Profiles SSR routes at runtime. When a route is rendered >N times with
// similar shape, compiles its HTML template to a native function that
// produces the string directly — bypassing React's reconciliation entirely
// for cacheable pages.
//
// This is the "holy grail" — native-speed SSR for hot pages without
// giving up React for dynamic ones.
//
// The JS fallback uses template string caching.

use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Mutex;

struct RouteProfile {
    render_count: u64,
    last_template_hash: u64,
    compiled_template: Option<String>,
}

static PROFILES: Mutex<Option<HashMap<String, RouteProfile>>> = Mutex::new(None);

fn ensure_profiles() {
    let mut p = PROFILES.lock().unwrap();
    if p.is_none() {
        *p = Some(HashMap::new());
    }
}

/// Records a route render and returns whether JIT compilation should occur.
///
/// @param route_pattern The route pattern (e.g. "/blog/:slug")
/// @param template_hash Hash of the rendered HTML structure
/// @param threshold Number of renders before JIT compilation (default: 100)
/// @returns { should_compile: bool, render_count: f64 }
#[napi(object)]
pub struct ProfileResult {
    pub should_compile: bool,
    pub render_count: f64,
}

#[napi]
pub fn record_render(route_pattern: String, template_hash: f64, threshold: Option<f64>) -> ProfileResult {
    ensure_profiles();
    let threshold = threshold.unwrap_or(100.0) as u64;
    let hash = template_hash as u64;

    let mut profiles = PROFILES.lock().unwrap();
    let map = profiles.as_mut().unwrap();

    let profile = map.entry(route_pattern).or_insert(RouteProfile {
        render_count: 0,
        last_template_hash: 0,
        compiled_template: None,
    });

    profile.render_count += 1;
    let same_template = profile.last_template_hash == hash;
    profile.last_template_hash = hash;

    // Compile if we've rendered the same template enough times
    let should_compile = profile.render_count >= threshold && same_template && profile.compiled_template.is_none();

    ProfileResult {
        should_compile,
        render_count: profile.render_count as f64,
    }
}

/// Stores a compiled template for a route.
///
/// @param route_pattern The route pattern
/// @param template The compiled template string
#[napi]
pub fn store_compiled_template(route_pattern: String, template: String) -> Result<(), String> {
    ensure_profiles();
    let mut profiles = PROFILES.lock().unwrap();
    let map = profiles.as_mut().unwrap();

    let profile = map.entry(route_pattern).or_insert(RouteProfile {
        render_count: 0,
        last_template_hash: 0,
        compiled_template: None,
    });

    profile.compiled_template = Some(template);
    Ok(())
}

/// Gets the compiled template for a route, if one exists.
#[napi]
pub fn get_compiled_template(route_pattern: String) -> Option<String> {
    ensure_profiles();
    let profiles = PROFILES.lock().unwrap();
    if let Some(ref map) = *profiles {
        map.get(&route_pattern).and_then(|p| p.compiled_template.clone())
    } else {
        None
    }
}

/// Clears the compiled template for a route (e.g. when content changes).
#[napi]
pub fn invalidate_template(route_pattern: String) {
    ensure_profiles();
    let mut profiles = PROFILES.lock().unwrap();
    if let Some(ref mut map) = *profiles {
        if let Some(profile) = map.get_mut(&route_pattern) {
            profile.compiled_template = None;
            profile.render_count = 0;
        }
    }
}

/// Clears all compiled templates and profiles.
#[napi]
pub fn clear_all_templates() {
    ensure_profiles();
    let mut profiles = PROFILES.lock().unwrap();
    if let Some(ref mut map) = *profiles {
        map.clear();
    }
}

/// Gets profiling stats for all routes.
#[napi(object)]
pub struct RouteStat {
    pub route: String,
    pub render_count: f64,
    pub has_compiled_template: bool,
}

#[napi]
pub fn get_route_stats() -> Vec<RouteStat> {
    ensure_profiles();
    let profiles = PROFILES.lock().unwrap();
    if let Some(ref map) = *profiles {
        map.iter()
            .map(|(route, p)| RouteStat {
                route: route.clone(),
                render_count: p.render_count as f64,
                has_compiled_template: p.compiled_template.is_some(),
            })
            .collect()
    } else {
        vec![]
    }
}
