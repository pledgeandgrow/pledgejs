// #244 — SSR profiling in Rust.
//
// Per-component render time profiling with flamegraph generation.
// Provides native-speed timing that doesn't perturb measurements.

use napi_derive::napi;
use std::cell::RefCell;
use std::time::Instant;

/// Profile frame for a single component render.
#[napi(object)]
pub struct ProfileFrame {
    pub name: String,
    pub start_us: f64,
    pub duration_us: f64,
    pub depth: i32,
    pub renderer: String,
    pub children: Vec<ProfileFrame>,
    pub props_summary: Option<String>,
}

/// Component timing aggregate.
#[napi(object)]
pub struct ComponentTiming {
    pub name: String,
    pub render_count: i32,
    pub total_time_us: f64,
    pub avg_time_us: f64,
    pub max_time_us: f64,
    pub min_time_us: f64,
}

/// Profile result.
#[napi(object)]
pub struct ProfileResult {
    pub frames: Vec<ProfileFrame>,
    pub timings: Vec<ComponentTiming>,
    pub total_time_us: f64,
    pub component_count: i32,
    pub flamegraph: String,
}

struct StackEntry {
    frame: ProfileFrame,
    start: Instant,
}

thread_local! {
    /// Thread-local profiling state.
    static ACTIVE: RefCell<Option<ProfilingState>> = const { RefCell::new(None) };
}

struct ProfilingState {
    frames: Vec<ProfileFrame>,
    stack: Vec<StackEntry>,
    start_time: Instant,
}

/// Starts a profiling session.
#[napi]
pub fn start_profiling() -> bool {
    ACTIVE.with(|active| {
        let mut state = active.borrow_mut();
        if state.is_some() {
            return false;
        }
        *state = Some(ProfilingState {
            frames: Vec::new(),
            stack: Vec::new(),
            start_time: Instant::now(),
        });
        true
    })
}

/// Stops profiling and returns the result.
#[napi]
pub fn stop_profiling() -> Option<ProfileResult> {
    ACTIVE.with(|active| {
        let mut state_opt = active.borrow_mut();
        let state = state_opt.take()?;
        let total_time = state.start_time.elapsed().as_micros() as f64;
        let timings = aggregate_timings(&state.frames);
        let flamegraph = generate_flamegraph(&state.frames, 0);
        let component_count = state.frames.len() as i32;
        Some(ProfileResult {
            frames: state.frames,
            timings,
            total_time_us: total_time,
            component_count,
            flamegraph,
        })
    })
}

/// Records a component render start.
#[napi]
pub fn record_render_start(name: String, renderer: String, props_summary: Option<String>) {
    ACTIVE.with(|active| {
        let mut state_opt = active.borrow_mut();
        if state_opt.is_none() {
            return;
        }
        let state = state_opt.as_mut().unwrap();
        let depth = state.stack.len() as i32;
        let elapsed = state.start_time.elapsed().as_micros() as f64;
        let frame = ProfileFrame {
            name: name.clone(),
            start_us: elapsed,
            duration_us: 0.0,
            depth,
            renderer: renderer.clone(),
            children: Vec::new(),
            props_summary: props_summary.clone(),
        };
        state.stack.push(StackEntry {
            frame,
            start: Instant::now(),
        });
    });
}

/// Records a component render end.
#[napi]
pub fn record_render_end() {
    ACTIVE.with(|active| {
        let mut state_opt = active.borrow_mut();
        if state_opt.is_none() {
            return;
        }
        let state = state_opt.as_mut().unwrap();
        if let Some(entry) = state.stack.pop() {
            let duration = entry.start.elapsed().as_micros() as f64;
            let mut frame = entry.frame;
            frame.duration_us = duration;

            if let Some(parent) = state.stack.last_mut() {
                parent.frame.children.push(frame);
            } else {
                state.frames.push(frame);
            }
        }
    });
}

fn aggregate_timings(frames: &[ProfileFrame]) -> Vec<ComponentTiming> {
    let mut map: std::collections::HashMap<String, ComponentTiming> =
        std::collections::HashMap::new();

    fn walk(frame: &ProfileFrame, map: &mut std::collections::HashMap<String, ComponentTiming>) {
        let entry = map
            .entry(frame.name.clone())
            .or_insert_with(|| ComponentTiming {
                name: frame.name.clone(),
                render_count: 0,
                total_time_us: 0.0,
                avg_time_us: 0.0,
                max_time_us: 0.0,
                min_time_us: f64::MAX,
            });
        entry.render_count += 1;
        entry.total_time_us += frame.duration_us;
        entry.max_time_us = entry.max_time_us.max(frame.duration_us);
        entry.min_time_us = entry.min_time_us.min(frame.duration_us);
        for child in &frame.children {
            walk(child, map);
        }
    }

    for frame in frames {
        walk(frame, &mut map);
    }

    let mut result: Vec<ComponentTiming> = map.into_values().collect();
    for t in &mut result {
        t.avg_time_us = t.total_time_us / t.render_count as f64;
    }
    result.sort_by(|a, b| {
        b.total_time_us
            .partial_cmp(&a.total_time_us)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    result
}

fn generate_flamegraph(frames: &[ProfileFrame], indent: i32) -> String {
    let mut out = String::new();
    for frame in frames {
        let pad = " ".repeat(indent as usize * 2);
        let bar_len = ((frame.duration_us / 10.0).round() as usize).min(50);
        let bar = "█".repeat(bar_len);
        out.push_str(&format!(
            "{}{} [{}] {:>8.1}μs {}{}\n",
            pad,
            frame.name,
            frame.renderer,
            frame.duration_us,
            bar,
            frame
                .props_summary
                .as_ref()
                .map(|s| format!(" props={}", s))
                .unwrap_or_default()
        ));
        if !frame.children.is_empty() {
            out.push_str(&generate_flamegraph(&frame.children, indent + 1));
        }
    }
    out
}
