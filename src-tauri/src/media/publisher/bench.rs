//! Where a screen share's frame time actually goes.
//!
//! Every test here is ignored and prints rather than asserts. Run one with:
//!
//! ```text
//! cargo test --release -p Venta --lib -- --ignored --nocapture bench_capture_ceiling
//! ```
//!
//! Release only. A debug build of `nv12::convert` alone is 20x off and makes every number here a
//! measurement of the profile rather than of the pipeline.

use std::sync::atomic::{AtomicBool, AtomicU32};
use std::sync::Arc;
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::encoder::{new_encoder, CapturedFrame, EncodeOutcome, EncoderContent, EncoderSpec};
use super::fit::fit_into;
use super::nv12;
use super::pump::{FramePump, LocalStreamSink, PumpLayer};
use super::simulcast;
use crate::media::screen::{find_capture_source, CaptureHandle};

/// Frames per measured run. Long enough that a warm-up artefact averages out, short enough that a
/// full sweep is under a minute.
const RUN_FRAMES: usize = 90;

/// The share the numbers in this file are about: 1080p60.
const SHARE: EncoderSpec = EncoderSpec {
    width: 1920,
    height: 1080,
    fps: 60,
    kbps: 16_000,
    content: EncoderContent::Text,
};

// ── Reporting ─────────────────────────────────────────────────────────────────

struct Samples {
    name: String,
    ms: Vec<f64>,
}

impl Samples {
    fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ms: Vec::with_capacity(RUN_FRAMES),
        }
    }

    fn push(&mut self, elapsed: Duration) {
        self.ms.push(elapsed.as_secs_f64() * 1000.0);
    }

    fn mean(&self) -> f64 {
        if self.ms.is_empty() {
            return 0.0;
        }
        self.ms.iter().sum::<f64>() / self.ms.len() as f64
    }

    fn quantile(&self, q: f64) -> f64 {
        if self.ms.is_empty() {
            return 0.0;
        }
        let mut sorted = self.ms.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        sorted[((sorted.len() - 1) as f64 * q).round() as usize]
    }

    fn report(&self) {
        println!(
            "  {:<34} mean {:7.2} ms  p50 {:7.2}  p95 {:7.2}  max {:7.2}   ({:5.1} fps)",
            self.name,
            self.mean(),
            self.quantile(0.50),
            self.quantile(0.95),
            self.quantile(1.0),
            if self.mean() > 0.0 { 1000.0 / self.mean() } else { 0.0 },
        );
    }
}

fn rule(title: &str) {
    println!("\n== {title} {}", "=".repeat(70usize.saturating_sub(title.len())));
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/// A frame with structure. A flat one costs the encoder almost nothing and would report a frame
/// time no real screen ever produces.
fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
    RgbaImage::from_fn(width, height, |x, y| {
        let v = (((x + shift) / 8 + y / 8) % 2) as u8;
        image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
    })
}

/// The biggest window on this desktop that is worth capturing, as a source id.
fn a_window() -> Option<(String, String)> {
    let windows = xcap::Window::all().ok()?;
    let mut best: Option<(u32, String, u64)> = None;
    for w in windows {
        if w.is_minimized().unwrap_or(true) {
            continue;
        }
        let Ok(title) = w.title() else { continue };
        if title.trim().is_empty() {
            continue;
        }
        let (width, height) = (w.width().unwrap_or(0), w.height().unwrap_or(0));
        if width < 640 || height < 480 {
            continue;
        }
        let area = width as u64 * height as u64;
        let Ok(id) = w.id() else { continue };
        if best.as_ref().is_none_or(|(_, _, seen)| area > *seen) {
            best = Some((id, title, area));
        }
    }
    best.map(|(id, title, _)| (format!("window:{id}"), title))
}

/// Drops whatever it is handed. The pump's local-stream copy costs an allocation and a memcpy per
/// frame whether or not anybody reads the other end, and production has it on.
struct NullLocalStream;

impl LocalStreamSink for NullLocalStream {
    fn send(&self, _access_unit: Vec<u8>) {}
}

// ── 1. What one capture costs ─────────────────────────────────────────────────

fn measure_capture(label: &str, source: &CaptureHandle) {
    // Warm up: the first call builds the GraphicsCaptureItem and caches it, and the D3D device is
    // a process-wide lazy static. Neither belongs in the steady-state number.
    for _ in 0..5 {
        let _ = source.capture();
    }

    let mut samples = Samples::new(label);
    let mut size = (0u32, 0u32);
    let mut failures = 0usize;
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        match source.capture() {
            Some((_, w, h)) => {
                samples.push(started.elapsed());
                size = (w, h);
            }
            None => failures += 1,
        }
    }
    samples.report();
    println!(
        "  {:<34} source {}x{}, {failures} failed grabs",
        "", size.0, size.1
    );
}

/// What `CaptureHandle::capture` alone costs, with nothing downstream of it.
///
/// This is the ceiling the rest of the pipeline is spent under. Nothing below can be faster.
#[test]
#[ignore = "benchmark: drives real screen capture"]
fn bench_capture_ceiling() {
    rule("capture alone, nothing downstream");

    match find_capture_source("monitor:0") {
        Some(source) => measure_capture("monitor:0", &source),
        None => println!("  monitor:0 not found"),
    }

    match a_window() {
        Some((id, title)) => match find_capture_source(&id) {
            Some(source) => {
                println!("  window under test: {title}");
                measure_capture(&id, &source);
            }
            None => println!("  {id} ({title}) could not be opened"),
        },
        None => println!("  no window big enough to bench"),
    }
}

// ── 2. What the pump does to a frame, stage by stage ──────────────────────────

/// Fit, scale, convert, preview: every CPU pass over a 1080p frame, priced separately.
#[test]
#[ignore = "benchmark"]
fn bench_pump_stages() {
    rule("per-frame CPU work, 1080p source into a 1080p share");

    let ladder = simulcast::layers_for(SHARE, simulcast::LAYER_RIDS.len());
    let sources: Vec<RgbaImage> = (0..4).map(|i| frame(SHARE.width, SHARE.height, i * 7)).collect();

    let mut identity = Samples::new("fit_into 1920x1080 (no resize)");
    for i in 0..RUN_FRAMES {
        let started = Instant::now();
        let out = fit_into(&sources[i % 4], SHARE.width, SHARE.height);
        identity.push(started.elapsed());
        std::hint::black_box(out);
    }
    identity.report();

    let fitted = fit_into(&sources[0], SHARE.width, SHARE.height).into_owned();
    for rung in ladder.iter().skip(1) {
        let mut scale = Samples::new(format!(
            "fit_into {}x{} (layer {})",
            rung.spec.width, rung.spec.height, rung.rid
        ));
        for _ in 0..RUN_FRAMES {
            let started = Instant::now();
            let out = fit_into(&fitted, rung.spec.width, rung.spec.height);
            scale.push(started.elapsed());
            std::hint::black_box(out);
        }
        scale.report();
    }

    for rung in ladder.iter() {
        let input = fit_into(&fitted, rung.spec.width, rung.spec.height);
        let mut buf = Vec::new();
        let mut convert = Samples::new(format!(
            "nv12::convert {}x{} (layer {})",
            rung.spec.width, rung.spec.height, rung.rid
        ));
        for _ in 0..RUN_FRAMES {
            let started = Instant::now();
            nv12::convert(&input, &mut buf);
            convert.push(started.elapsed());
        }
        convert.report();
    }

    // The thumbnail, both ways: filtered down from the top layer, and taken straight from the
    // bottom rung, which is already 480 wide.
    let mut buf = Vec::new();
    let mut from_top = Samples::new("preview from the top layer (filtered)");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        let thumb = image::DynamicImage::ImageRgba8(fitted.clone())
            .resize(480, 270, image::imageops::FilterType::Triangle)
            .to_rgb8();
        crate::media::screen::encode_jpeg_into(&image::DynamicImage::ImageRgb8(thumb), 70, &mut buf);
        let _ = crate::media::screen::base64_encode(&buf);
        from_top.push(started.elapsed());
    }
    from_top.report();

    let bottom = fit_into(&fitted, 480, 270).into_owned();
    let mut from_bottom = Samples::new("preview from the bottom rung (no filter)");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        crate::media::screen::encode_jpeg_into(
            &image::DynamicImage::ImageRgba8(bottom.clone()),
            70,
            &mut buf,
        );
        let _ = crate::media::screen::base64_encode(&buf);
        from_bottom.push(started.elapsed());
    }
    from_bottom.report();
}

// ── 3. What one encoder costs, and what the ladder costs ──────────────────────

/// Each rung's encoder on its own, and then all three in the order the pump drives them.
#[test]
#[ignore = "benchmark: builds real Media Foundation encoders"]
fn bench_encoder_ladder() {
    rule("encoders, fed pre-fitted frames");

    let ladder = simulcast::layers_for(SHARE, simulcast::LAYER_RIDS.len());
    let mut encoders = Vec::new();
    for rung in &ladder {
        match new_encoder(rung.spec) {
            Some(encoder) => encoders.push(encoder),
            None => {
                println!("  no encoder for {}x{}", rung.spec.width, rung.spec.height);
                return;
            }
        }
    }

    let mut inputs: Vec<Vec<RgbaImage>> = Vec::new();
    for rung in &ladder {
        inputs.push(
            (0..4)
                .map(|i| frame(rung.spec.width, rung.spec.height, i * 7))
                .collect(),
        );
    }

    for (index, rung) in ladder.iter().enumerate() {
        let mut samples = Samples::new(format!(
            "encode {}x{} (layer {}, incl. nv12)",
            rung.spec.width, rung.spec.height, rung.rid
        ));
        let mut chunks = 0usize;
        for i in 0..RUN_FRAMES {
            let started = Instant::now();
            let outcome = encoders[index].encode(CapturedFrame::Cpu(&inputs[index][i % 4]), i as u64 * 16_666);
            samples.push(started.elapsed());
            if matches!(outcome, EncodeOutcome::Chunk(_)) {
                chunks += 1;
            }
        }
        samples.report();
        println!("  {:<34} {chunks}/{RUN_FRAMES} chunks out", "");
    }

    let mut whole = Samples::new("all three, one frame's worth");
    for i in 0..RUN_FRAMES {
        let started = Instant::now();
        for (index, _) in ladder.iter().enumerate() {
            std::hint::black_box(encoders[index].encode(CapturedFrame::Cpu(&inputs[index][i % 4]), i as u64 * 16_666));
        }
        whole.push(started.elapsed());
    }
    whole.report();
}

// ── 4. The whole thing, as the capture thread runs it ─────────────────────────

fn drained_layer(
    spec: EncoderSpec,
) -> Option<(PumpLayer, std::thread::JoinHandle<()>)> {
    let encoder = new_encoder(spec)?;
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(2);
    let drain = std::thread::spawn(move || while frame_rx.blocking_recv().is_some() {});
    Some((
        PumpLayer {
            encoder,
            frame_tx,
            width: spec.width,
            height: spec.height,
        },
        drain,
    ))
}

fn run_whole_pipeline(source: &CaptureHandle, label: &str, layer_count: usize) {
    let ladder = simulcast::layers_for(SHARE, layer_count);
    let mut layers = Vec::new();
    let mut drains = Vec::new();
    for rung in &ladder {
        let Some((layer, drain)) = drained_layer(rung.spec) else {
            println!("  {label}: no encoder for {}x{}", rung.spec.width, rung.spec.height);
            return;
        };
        layers.push(layer);
        drains.push(drain);
    }

    let mut pump = FramePump::new(
        layers,
        Arc::new(AtomicU32::new(SHARE.fps)),
        Arc::new(AtomicBool::new(false)),
        (),
    )
    .with_local_stream(Box::new(NullLocalStream), Arc::new(AtomicBool::new(true)));

    for _ in 0..5 {
        if let Some((rgba, _, _)) = source.capture() {
            pump.on_frame(&rgba);
        }
    }

    let mut capture = Samples::new(format!("{label}: capture"));
    let mut pumped = Samples::new(format!("{label}: pump (fit+scale+nv12+encode)"));
    let mut total = Samples::new(format!("{label}: whole frame"));

    // Unpaced on purpose. `run_capture_loop` sleeps only when it is ahead of schedule, and a share
    // that misses its interval never is - so what it does at 60 fps is exactly this loop.
    for _ in 0..RUN_FRAMES {
        let frame_started = Instant::now();
        let started = Instant::now();
        let Some((rgba, _, _)) = source.capture() else {
            continue;
        };
        capture.push(started.elapsed());

        let started = Instant::now();
        pump.on_frame(&rgba);
        pumped.push(started.elapsed());
        total.push(frame_started.elapsed());
    }

    capture.report();
    pumped.report();
    total.report();

    drop(pump);
    for drain in drains {
        let _ = drain.join();
    }
}

// ── 5. Controls: does the suspected fix actually move the number? ─────────────

/// Average each 2x2 block. Only valid for an exact halving, which is what every simulcast rung
/// below the top one is.
fn halve(src: &RgbaImage) -> RgbaImage {
    let (width, height) = (src.width() as usize / 2, src.height() as usize / 2);
    let stride = src.width() as usize * 4;
    let raw = src.as_raw();
    let mut out = Vec::with_capacity(width * height * 4);

    for y in 0..height {
        let top = y * 2 * stride;
        let bottom = top + stride;
        for x in 0..width {
            let a = top + x * 8;
            let b = bottom + x * 8;
            for channel in 0..4 {
                let sum = raw[a + channel] as u16
                    + raw[a + 4 + channel] as u16
                    + raw[b + channel] as u16
                    + raw[b + 4 + channel] as u16;
                out.push((sum / 4) as u8);
            }
        }
    }

    RgbaImage::from_raw(width as u32, height as u32, out).expect("an exact halving")
}

/// `fit_into` against the two things it is actually asked to do on the layer path.
#[test]
#[ignore = "benchmark"]
fn bench_downscale_alternatives() {
    rule("downscaling 1920x1080 to 960x540, four ways");

    let source = frame(SHARE.width, SHARE.height, 0);

    let mut current = Samples::new("fit_into (DynamicImage::resize)");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box(fit_into(&source, 960, 540));
        current.push(started.elapsed());
    }
    current.report();

    let mut no_clone = Samples::new("imageops::resize, no clone first");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box(image::imageops::resize(
            &source,
            960,
            540,
            image::imageops::FilterType::Triangle,
        ));
        no_clone.push(started.elapsed());
    }
    no_clone.report();

    let mut nearest = Samples::new("imageops::resize, Nearest");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box(image::imageops::resize(
            &source,
            960,
            540,
            image::imageops::FilterType::Nearest,
        ));
        nearest.push(started.elapsed());
    }
    nearest.report();

    let mut boxed = Samples::new("2x2 box average (exact halving)");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box(halve(&source));
        boxed.push(started.elapsed());
    }
    boxed.report();

    // The other resize the pump does: a 4K monitor fitted down to a 1080p share. Also an exact
    // halving, so the same fast path covers it.
    let uhd = frame(3840, 2160, 0);
    let mut uhd_fit = Samples::new("fit_into 3840x2160 -> 1920x1080");
    for _ in 0..30 {
        let started = Instant::now();
        std::hint::black_box(fit_into(&uhd, 1920, 1080));
        uhd_fit.push(started.elapsed());
    }
    uhd_fit.report();

    let mut uhd_box = Samples::new("2x2 box 3840x2160 -> 1920x1080");
    for _ in 0..30 {
        let started = Instant::now();
        std::hint::black_box(halve(&uhd));
        uhd_box.push(started.elapsed());
    }
    uhd_box.report();

    // The case the block average cannot take: neither axis divides whole, so this is still the
    // general separable filter. A 1440p monitor and an odd-sized window both land here.
    for (w, h, label) in [
        (2560u32, 1440u32, "2560x1440 -> 1920x1080 (1440p monitor)"),
        (3815, 2081, "3815x2081 -> 1920x1080 (odd window)"),
    ] {
        let source = frame(w, h, 0);
        let mut samples = Samples::new(format!("fit_into {label}"));
        for _ in 0..20 {
            let started = Instant::now();
            std::hint::black_box(fit_into(&source, 1920, 1080));
            samples.push(started.elapsed());
        }
        samples.report();
    }

    let mut identity_clone = Samples::new("fit_into identity (the clone alone)");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box(fit_into(&source, SHARE.width, SHARE.height));
        identity_clone.push(started.elapsed());
    }
    identity_clone.report();
}

/// How much of a grab is the session, and how much is the pixels.
///
/// `capture_region` runs the identical per-call path - build the device wrapper, create a frame
/// pool, create and start a session, wait for the arrival callback, tear it all down - and differs
/// only in how many pixels come back. A 64x64 region therefore prices the fixed part on its own.
#[test]
#[ignore = "benchmark: drives real screen capture"]
fn bench_capture_overhead_split() {
    rule("capture: fixed per-call cost against per-pixel cost");

    let Ok(monitors) = xcap::Monitor::all() else {
        println!("  no monitors");
        return;
    };
    let Some(monitor) = monitors.into_iter().next() else {
        println!("  no monitors");
        return;
    };
    let (full_w, full_h) = (
        monitor.width().unwrap_or(0),
        monitor.height().unwrap_or(0),
    );
    println!(
        "  monitor {}x{} at {:.0} Hz",
        full_w,
        full_h,
        monitor.frequency().unwrap_or(0.0)
    );

    for (w, h) in [(64u32, 64u32), (640, 360), (1280, 720), (full_w, full_h)] {
        if w == 0 || h == 0 || w > full_w || h > full_h {
            continue;
        }
        for _ in 0..3 {
            let _ = monitor.capture_region(0, 0, w, h);
        }
        let mut samples = Samples::new(format!("capture_region {w}x{h}"));
        for _ in 0..RUN_FRAMES {
            let started = Instant::now();
            match monitor.capture_region(0, 0, w, h) {
                Ok(image) => {
                    samples.push(started.elapsed());
                    std::hint::black_box(image);
                }
                Err(e) => {
                    println!("  {w}x{h}: {e}");
                    break;
                }
            }
        }
        samples.report();
    }

    let Some((id, title)) = a_window() else {
        println!("  no window big enough to bench");
        return;
    };
    println!("  window under test: {title}");
    let Some(window) = xcap::Window::all()
        .ok()
        .and_then(|all| {
            let target: u32 = id.trim_start_matches("window:").parse().ok()?;
            all.into_iter().find(|w| w.id().ok() == Some(target))
        })
    else {
        println!("  window vanished");
        return;
    };

    // Everything `xcap::capture_window` does before it touches WGC at all, per frame.
    let mut meta = Samples::new("window: per-frame metadata queries");
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        std::hint::black_box((
            window.pid().ok(),
            window.width().ok(),
            window.height().ok(),
            window.current_monitor().and_then(|m| m.scale_factor()).ok(),
        ));
        meta.push(started.elapsed());
    }
    meta.report();
}

/// Every monitor, and every window big enough to share, priced individually.
///
/// The question this answers is whether a grab costs pixels or costs *presents*. If it is presents,
/// the number tracks the surface's refresh rate and not its size, and a window that is not
/// repainting is far worse than any monitor however small it is.
#[test]
#[ignore = "benchmark: drives real screen capture"]
fn bench_capture_by_source() {
    rule("every source on this desktop");

    for (index, monitor) in xcap::Monitor::all().unwrap_or_default().into_iter().enumerate() {
        let (w, h) = (monitor.width().unwrap_or(0), monitor.height().unwrap_or(0));
        let hz = monitor.frequency().unwrap_or(0.0) as f64;
        for _ in 0..3 {
            let _ = monitor.capture_image();
        }
        let mut samples = Samples::new(format!("monitor:{index} {w}x{h} @{hz:.0}Hz"));
        for _ in 0..30 {
            let started = Instant::now();
            if monitor.capture_image().is_ok() {
                samples.push(started.elapsed());
            }
        }
        samples.report();
        if hz > 0.0 {
            println!(
                "  {:<34} refresh period {:.2} ms, so {:.1} periods per grab",
                "",
                1000.0 / hz,
                samples.mean() * hz / 1000.0
            );
        }
    }

    let mut windows: Vec<xcap::Window> = xcap::Window::all()
        .unwrap_or_default()
        .into_iter()
        .filter(|w| {
            !w.is_minimized().unwrap_or(true)
                && w.width().unwrap_or(0) >= 400
                && w.height().unwrap_or(0) >= 300
                && w.title().map(|t| !t.trim().is_empty()).unwrap_or(false)
        })
        .collect();
    windows.sort_by_key(|w| w.width().unwrap_or(0) as u64 * w.height().unwrap_or(0) as u64);

    for window in windows.iter().take(6) {
        let (w, h) = (window.width().unwrap_or(0), window.height().unwrap_or(0));
        let title = window.title().unwrap_or_default();
        let title: String = title.chars().take(22).collect();
        for _ in 0..3 {
            let _ = window.capture_image();
        }
        let mut samples = Samples::new(format!("window {w}x{h} {title}"));
        let mut failed = 0;
        for _ in 0..30 {
            let started = Instant::now();
            if window.capture_image().is_ok() {
                samples.push(started.elapsed());
            } else {
                failed += 1;
            }
        }
        samples.report();
        if failed > 0 {
            println!("  {:<34} {failed}/30 grabs failed outright", "");
        }
    }
}

/// PSNR of `candidate` against `reference`, in dB. Above ~50 the two are indistinguishable.
fn psnr(reference: &RgbaImage, candidate: &RgbaImage) -> f64 {
    assert_eq!(reference.dimensions(), candidate.dimensions());
    let mut sum = 0f64;
    for (a, b) in reference.as_raw().iter().zip(candidate.as_raw()) {
        let d = *a as f64 - *b as f64;
        sum += d * d;
    }
    let mse = sum / reference.as_raw().len() as f64;
    if mse == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (255.0f64 * 255.0 / mse).log10()
}

/// Whether the cheap halving costs any picture.
///
/// Lanczos3 is the reference, not the incumbent: the question is which of the two fast paths lands
/// closer to a proper downscale, and Triangle at exactly 0.5 is not automatically the better one.
/// A 2x2 box average *is* the correct area average at this ratio, which Triangle only approximates.
#[test]
#[ignore = "benchmark"]
fn bench_downscale_quality() {
    rule("halving quality, against a Lanczos3 reference");

    for shift in [0u32, 3, 7] {
        let source = frame(SHARE.width, SHARE.height, shift);
        let reference =
            image::imageops::resize(&source, 960, 540, image::imageops::FilterType::Lanczos3);
        let triangle =
            image::imageops::resize(&source, 960, 540, image::imageops::FilterType::Triangle);
        let nearest =
            image::imageops::resize(&source, 960, 540, image::imageops::FilterType::Nearest);
        let boxed = halve(&source);

        println!(
            "  frame shift {shift}:  Triangle (today) {:6.2} dB   2x2 box {:6.2} dB   Nearest {:6.2} dB",
            psnr(&reference, &triangle),
            psnr(&reference, &boxed),
            psnr(&reference, &nearest),
        );
    }
}

/// One WGC session held open, against the one-session-per-frame `CaptureHandle::capture` does.
///
/// The control for the whole capture half of this file. `xcap`'s recorder API is the same WGC
/// plumbing with the pool and the session created once instead of per grab, and it hands frames
/// over from the arrival callback - so the pixel download happens off the capture thread too.
#[test]
#[ignore = "benchmark: drives real screen capture"]
fn bench_persistent_session() {
    rule("one capture session held open, monitor 0");

    let Ok(monitors) = xcap::Monitor::all() else {
        println!("  no monitors");
        return;
    };
    let Some(monitor) = monitors.into_iter().next() else {
        println!("  no monitors");
        return;
    };

    let Ok((recorder, frames)) = monitor.video_recorder() else {
        println!("  could not build a recorder");
        return;
    };
    if let Err(e) = recorder.start() {
        println!("  could not start the recorder: {e}");
        return;
    }

    for i in 0..5 {
        match frames.recv_timeout(Duration::from_secs(2)) {
            Ok(frame) => println!("  warm-up {i}: {}x{}", frame.width, frame.height),
            Err(e) => println!("  warm-up {i}: {e}"),
        }
    }

    let mut samples = Samples::new("persistent session: next frame");
    let mut size = (0u32, 0u32);
    for _ in 0..RUN_FRAMES {
        let started = Instant::now();
        match frames.recv_timeout(Duration::from_secs(2)) {
            Ok(frame) => {
                samples.push(started.elapsed());
                size = (frame.width, frame.height);
            }
            Err(e) => {
                println!("  stopped early: {e}");
                break;
            }
        }
    }
    let _ = recorder.stop();

    samples.report();
    println!("  {:<34} source {}x{}", "", size.0, size.1);
}

// ── 6. The zero-copy path, end to end ─────────────────────────────────────────

/// User plus kernel time this process has been scheduled for, across every thread.
///
/// The number the whole exercise is about. Wall-clock frame time says whether the share keeps up;
/// this says what it costs the machine it is running on, which is what a game notices.
#[cfg(target_os = "windows")]
fn process_cpu_time() -> Duration {
    use windows::Win32::Foundation::FILETIME;
    use windows::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // Reading four out-params from a handle that is always valid.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    }
    .is_ok();
    if !ok {
        return Duration::ZERO;
    }

    let ticks = |t: FILETIME| ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64;
    // FILETIME counts 100 ns intervals.
    Duration::from_nanos((ticks(kernel) + ticks(user)) * 100)
}

/// The acceptance measurement: run the real zero-copy share and report fps and CPU.
///
/// Runs the production loop rather than a stand-in, so pacing, the change-driven capture and the
/// re-encode of a static screen are all included. 2560x1440 is measured alongside 1080p because a
/// 2K source is the case the CPU path could never fit into a frame interval.
#[cfg(target_os = "windows")]
#[test]
#[ignore = "benchmark: drives real GPU capture and real encoders"]
fn bench_gpu_pipeline() {
    rule("zero-copy path");

    // Every monitor on this desktop, so a 2K or 4K source is measured as a source and not only as
    // an output geometry. A big source is the case the CPU path could never fit in a frame.
    let monitors = xcap::Monitor::all().unwrap_or_default();
    for (index, monitor) in monitors.iter().enumerate() {
        println!(
            "\n  source monitor:{index} {}x{} @{:.0}Hz",
            monitor.width().unwrap_or(0),
            monitor.height().unwrap_or(0),
            monitor.frequency().unwrap_or(0.0)
        );
        for share in [
            EncoderSpec { width: 1920, height: 1080, ..SHARE },
            EncoderSpec { width: 2560, height: 1440, kbps: 24_000, ..SHARE },
        ] {
            measure_gpu(&format!("monitor:{index}"), share);
        }
    }

    // The worst case on the old path by a wide margin: a large window measured 2.9 fps end to end,
    // because a fresh capture session per grab waited out several of the compositor's periods.
    match a_window() {
        Some((id, title)) => {
            println!("\n  source {id} ({title})");
            measure_gpu(&id, EncoderSpec { width: 1920, height: 1080, ..SHARE });
        }
        None => println!("\n  no window big enough to bench"),
    }
}

#[cfg(target_os = "windows")]
fn measure_gpu(source_id: &str, share: EncoderSpec) {
    use crate::media::publisher::gpu;

    {
        let ladder = simulcast::layers_for(share, simulcast::LAYER_RIDS.len());
        let device = match gpu::device::GpuDevice::new() {
            Ok(device) => Arc::new(device),
            Err(e) => {
                println!("  no D3D11 device: {e}");
                return;
            }
        };
        let pipeline =
            match gpu::pipeline::GpuPipeline::open(source_id, Arc::clone(&device), true) {
                Ok(pipeline) => pipeline,
                Err(e) => {
                    println!("  no GPU capture: {e}");
                    return;
                }
            };

        let mut layers = Vec::new();
        let mut drains = Vec::new();
        let mut built = true;
        for rung in &ladder {
            let Some(mut encoder) = super::encoder_mf::PooledEncoder::acquire(rung.spec) else {
                println!("  no encoder for {}x{}", rung.spec.width, rung.spec.height);
                built = false;
                break;
            };
            if let Err(e) = encoder.bind_to_device(&device.device) {
                println!("  {}x{} would not take textures: {e}", rung.spec.width, rung.spec.height);
                built = false;
                break;
            }
            let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(2);
            drains.push(std::thread::spawn(move || {
                let mut bytes = 0usize;
                while let Some((data, _)) = frame_rx.blocking_recv() {
                    bytes += data.len();
                }
                bytes
            }));
            layers.push(PumpLayer {
                encoder: Box::new(encoder),
                frame_tx,
                width: rung.spec.width,
                height: rung.spec.height,
            });
        }
        if !built {
            return;
        }

        let fps = Arc::new(AtomicU32::new(share.fps));
        let pump = FramePump::new(
            layers,
            Arc::clone(&fps),
            Arc::new(AtomicBool::new(false)),
            (),
        )
        .with_local_stream(Box::new(NullLocalStream), Arc::new(AtomicBool::new(true)));
        let counters = pump.counters();

        let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let cpu_before = process_cpu_time();
        let started = Instant::now();
        let loop_thread = std::thread::spawn(move || {
            gpu::pipeline::run_gpu_capture_loop(pipeline, pump, fps, stop_rx);
        });

        std::thread::sleep(MEASURE_FOR);
        drop(stop_tx);
        let _ = loop_thread.join();
        let elapsed = started.elapsed();
        let cpu = process_cpu_time().saturating_sub(cpu_before);

        let stats = counters.snapshot();
        let top = stats[0];
        let achieved = top.encoded_frames as f64 / elapsed.as_secs_f64();
        println!(
            "  {}x{}@{} 3 layers: {:5.1} fps achieved, {} keyframes, {} dropped at the writer",
            share.width, share.height, share.fps, achieved, top.keyframes, top.dropped_frames
        );
        println!(
            "  {:<34} CPU {:6.2} ms/frame ({:4.1}% of one core), {:6.2} ms wall/frame",
            "",
            cpu.as_secs_f64() * 1000.0 / top.encoded_frames.max(1) as f64,
            cpu.as_secs_f64() / elapsed.as_secs_f64() * 100.0,
            elapsed.as_secs_f64() * 1000.0 / top.encoded_frames.max(1) as f64,
        );
        for (index, layer) in stats.iter().enumerate() {
            println!(
                "  {:<34} layer {}: {} encoded, {} keyframes, {} dropped",
                "",
                simulcast::LAYER_RIDS.get(index).copied().unwrap_or("?"),
                layer.encoded_frames,
                layer.keyframes,
                layer.dropped_frames
            );
        }

        let bytes: usize = drains.into_iter().filter_map(|d| d.join().ok()).sum();
        println!(
            "  {:<34} {:.1} Mb/s across the ladder",
            "",
            bytes as f64 * 8.0 / elapsed.as_secs_f64() / 1_000_000.0
        );
    }
}

/// How long each zero-copy run is measured over. Long enough to average out the encoder's warm-up
/// and a keyframe or two, short enough that a sweep stays quick.
const MEASURE_FOR: Duration = Duration::from_secs(6);

/// Is the picture the zero-copy path produces actually the screen?
///
/// Throughput proves frames are being made, never that they are right, and this path replaced the
/// colour conversion outright: `nv12::convert`'s hand-written BT.709 matrix became the video
/// processor's, signalled through two bitfields. A swapped chroma pair, a full-range output where
/// studio range was declared, or a black letterbox covering everything would all leave every
/// number in this file untouched and every viewer looking at the wrong picture.
///
/// So the encoded stream is decoded back and compared, channel by channel, against what `xcap`
/// sees on the same monitor.
#[cfg(target_os = "windows")]
#[test]
#[ignore = "benchmark: drives real GPU capture, real encoders and a decoder"]
fn bench_gpu_picture_is_correct() {
    use crate::media::publisher::gpu;
    use openh264::decoder::Decoder;
    use openh264::formats::YUVSource;
    use openh264::OpenH264API;

    rule("does the zero-copy path produce the right picture");
    super::encoder::provision();

    let share = EncoderSpec { width: 1920, height: 1080, ..SHARE };
    let device = match gpu::device::GpuDevice::new() {
        Ok(device) => Arc::new(device),
        Err(e) => {
            println!("  no D3D11 device: {e}");
            return;
        }
    };
    let pipeline = match gpu::pipeline::GpuPipeline::open("monitor:0", Arc::clone(&device), true) {
        Ok(pipeline) => pipeline,
        Err(e) => {
            println!("  no GPU capture: {e}");
            return;
        }
    };
    let Some(mut encoder) = super::encoder_mf::PooledEncoder::acquire(share) else {
        println!("  no hardware encoder");
        return;
    };
    if let Err(e) = encoder.bind_to_device(&device.device) {
        println!("  the encoder would not take textures: {e}");
        return;
    }

    // One layer, so the decoded stream is unambiguously the top rung.
    let (frame_tx, mut frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(256);
    let pump = FramePump::new(
        vec![PumpLayer {
            encoder: Box::new(encoder),
            frame_tx,
            width: share.width,
            height: share.height,
        }],
        Arc::new(AtomicU32::new(share.fps)),
        Arc::new(AtomicBool::new(false)),
        (),
    );

    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let fps = Arc::new(AtomicU32::new(share.fps));
    let loop_thread = std::thread::spawn(move || {
        gpu::pipeline::run_gpu_capture_loop(pipeline, pump, fps, stop_rx);
    });
    std::thread::sleep(Duration::from_secs(2));
    // The reference is taken while the share is running, so both see the same desktop.
    let reference = xcap::Monitor::all()
        .ok()
        .and_then(|all| all.into_iter().next())
        .and_then(|m| m.capture_image().ok());
    std::thread::sleep(Duration::from_millis(500));
    drop(stop_tx);
    let _ = loop_thread.join();

    let Some(reference) = reference else {
        println!("  could not take a reference capture");
        return;
    };

    let api = OpenH264API::from_blob_path(
        super::openh264_blob::ready_path().expect("openh264 must be provisioned"),
    )
    .expect("the decoder api");
    let mut decoder = Decoder::with_api_config(api, Default::default()).expect("a decoder");

    let mut decoded: Option<(u32, u32, Vec<u8>)> = None;
    let mut units = 0usize;
    while let Ok((unit, _)) = frame_rx.try_recv() {
        units += 1;
        if let Ok(Some(yuv)) = decoder.decode(&unit) {
            let (width, height) = yuv.dimensions();
            let mut rgb = vec![0u8; width * height * 3];
            yuv.write_rgb8(&mut rgb);
            decoded = Some((width as u32, height as u32, rgb));
        }
    }

    let Some((width, height, rgb)) = decoded else {
        println!("  FAILED: nothing decoded out of {units} access units");
        return;
    };
    println!("  decoded {width}x{height} out of {units} access units");
    assert_eq!(
        (width, height),
        (share.width, share.height),
        "the decoded picture is not the share's geometry"
    );

    // Mean per channel, over both pictures. A swapped chroma pair moves red and blue in opposite
    // directions; a wrong range moves all three the same way; a black frame takes them to zero.
    let decoded_mean = mean_rgb(rgb.chunks_exact(3));
    let reference_mean = mean_rgb(reference.as_raw().chunks_exact(4));
    println!(
        "  decoded   R {:6.1}  G {:6.1}  B {:6.1}",
        decoded_mean[0], decoded_mean[1], decoded_mean[2]
    );
    println!(
        "  reference R {:6.1}  G {:6.1}  B {:6.1}",
        reference_mean[0], reference_mean[1], reference_mean[2]
    );

    let drift: Vec<f64> = (0..3)
        .map(|i| (decoded_mean[i] - reference_mean[i]).abs())
        .collect();
    println!(
        "  drift     R {:6.1}  G {:6.1}  B {:6.1}",
        drift[0], drift[1], drift[2]
    );
    // Generous: the two captures are milliseconds apart on a live desktop, and H.264 at this
    // bitrate is lossy. A channel swap or a range error is tens of levels, not single digits.
    for (channel, value) in ["red", "green", "blue"].iter().zip(&drift) {
        assert!(
            *value < 12.0,
            "the {channel} channel is {value:.1} levels off the reference, which is a colour fault \
             rather than compression"
        );
    }
    println!("  OK: the decoded picture matches the desktop");
}

/// Mean of the first three channels across a run of pixels.
#[cfg(target_os = "windows")]
fn mean_rgb<'a>(pixels: impl Iterator<Item = &'a [u8]>) -> [f64; 3] {
    let mut sums = [0f64; 3];
    let mut count = 0f64;
    for pixel in pixels {
        for (sum, value) in sums.iter_mut().zip(&pixel[..3]) {
            *sum += *value as f64;
        }
        count += 1.0;
    }
    if count == 0.0 {
        return [0.0; 3];
    }
    sums.map(|sum| sum / count)
}

/// The reproduction: real capture into the real pump, at the rate the capture thread would.
#[test]
#[ignore = "benchmark: drives real capture and real encoders"]
fn bench_whole_pipeline() {
    rule("end to end, 1080p60 share");

    if let Some(source) = find_capture_source("monitor:0") {
        run_whole_pipeline(&source, "monitor, 3 layers", simulcast::LAYER_RIDS.len());
        run_whole_pipeline(&source, "monitor, 1 layer ", 1);
    } else {
        println!("  monitor:0 not found");
    }

    match a_window() {
        Some((id, title)) => {
            println!("  window under test: {title}");
            match find_capture_source(&id) {
                Some(source) => {
                    run_whole_pipeline(&source, "window, 3 layers ", simulcast::LAYER_RIDS.len());
                    run_whole_pipeline(&source, "window, 1 layer  ", 1);
                }
                None => println!("  {id} could not be opened"),
            }
        }
        None => println!("  no window big enough to bench"),
    }
}
