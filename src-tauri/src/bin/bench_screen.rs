//! Screen-capture pipeline benchmark.
//!
//! Runs the full Rust-side pipeline (WGC capture → resize → JPEG encode →
//! base64) for `FRAMES` iterations and reports per-stage timing so you can
//! identify which step is the fps bottleneck.
//!
//! Run with:
//!   cargo run --bin bench-screen --release
//!
//! IMPORTANT: always use --release; debug mode is 10–20× slower and does not
//! reflect production performance.

use base64::Engine;
use image::DynamicImage;
use jpeg_encoder::ColorType;
use std::time::Instant;
use xcap::Monitor;

// ── Config ────────────────────────────────────────────────────────────────────

/// How many frames to capture.
const FRAMES: usize = 60;

/// Max output resolution (same as the Tauri app).
const MAX_W: u32 = 1920;
const MAX_H: u32 = 1080;

/// JPEG quality levels to test.  The app currently uses 75.
const QUALITIES: &[(u8, &str)] = &[
    (75, "current (75)"),
    (65, "lower    (65)"),
    (55, "fast     (55)"),
];

// ── Helpers ───────────────────────────────────────────────────────────────────

fn base64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn encode_jpeg_into(img: &DynamicImage, quality: u8, buf: &mut Vec<u8>) {
    buf.clear();
    let w = img.width() as u16;
    let h = img.height() as u16;
    let enc = jpeg_encoder::Encoder::new(buf, quality);
    let _ = match img {
        DynamicImage::ImageRgba8(rgba) => enc.encode(rgba.as_raw(), w, h, ColorType::Rgba),
        DynamicImage::ImageRgb8(rgb) => enc.encode(rgb.as_raw(), w, h, ColorType::Rgb),
        _ => {
            let rgb = img.to_rgb8();
            enc.encode(rgb.as_raw(), w, h, ColorType::Rgb)
        }
    };
}

// ── Per-frame measurements ────────────────────────────────────────────────────

struct FrameTiming {
    capture_us: u64,
    resize_us: u64,
    encode_us: u64,
    base64_us: u64,
    jpeg_bytes: usize,
    src_w: u32,
    src_h: u32,
}

impl FrameTiming {
    fn total_us(&self) -> u64 {
        self.capture_us + self.resize_us + self.encode_us + self.base64_us
    }
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

fn run_benchmark(monitor: &Monitor, quality: u8, label: &str) -> Vec<FrameTiming> {
    println!("\n▶ Quality {label}");
    println!(
        "{:>5}  {:>8} {:>8} {:>9} {:>8}  {:>8}  {:>7}",
        "frame", "capture", "resize", "jpeg_enc", "base64", "total", "fps"
    );
    println!("{}", "-".repeat(65));

    // Warm-up capture so WGC session is established before timing.
    for _ in 0..3 {
        let _ = monitor.capture_image();
    }

    let mut timings = Vec::with_capacity(FRAMES);
    let mut jpeg_buf = Vec::with_capacity(512 * 1024);

    for i in 0..FRAMES {
        // ── Stage 1: WGC capture ─────────────────────────────────────────────
        let t = Instant::now();
        let rgba = match monitor.capture_image() {
            Ok(img) => img,
            Err(e) => {
                eprintln!("  frame {i}: capture failed: {e}");
                continue;
            }
        };
        let capture_us = t.elapsed().as_micros() as u64;
        let (src_w, src_h) = (rgba.width(), rgba.height());

        // ── Stage 2: Resize ──────────────────────────────────────────────────
        let t = Instant::now();
        let dyn_img = DynamicImage::ImageRgba8(rgba);
        let dyn_img = if src_w > MAX_W || src_h > MAX_H {
            dyn_img.resize(MAX_W, MAX_H, image::imageops::FilterType::Triangle)
        } else {
            dyn_img
        };
        let resize_us = t.elapsed().as_micros() as u64;

        // ── Stage 3: JPEG encode (jpeg-encoder, RGB conversion + buffer reuse) ──
        let t = Instant::now();
        let rgb_img = dyn_img.to_rgb8();
        encode_jpeg_into(&DynamicImage::ImageRgb8(rgb_img), quality, &mut jpeg_buf);
        let encode_us = t.elapsed().as_micros() as u64;
        let jpeg_bytes = jpeg_buf.len();

        // ── Stage 4: Base64 encode ───────────────────────────────────────────
        let t = Instant::now();
        let _ = base64_encode(&jpeg_buf);
        let base64_us = t.elapsed().as_micros() as u64;

        let timing = FrameTiming {
            capture_us,
            resize_us,
            encode_us,
            base64_us,
            jpeg_bytes,
            src_w,
            src_h,
        };
        let total_us = timing.total_us();
        let fps = if total_us > 0 {
            1_000_000.0 / total_us as f64
        } else {
            0.0
        };

        println!(
            "{:>5}  {:>6.1}ms {:>6.1}ms {:>7.1}ms {:>6.1}ms  {:>6.1}ms  {:>6.1}",
            i,
            capture_us as f64 / 1000.0,
            resize_us as f64 / 1000.0,
            encode_us as f64 / 1000.0,
            base64_us as f64 / 1000.0,
            total_us as f64 / 1000.0,
            fps
        );

        timings.push(timing);
    }

    timings
}

fn print_summary(timings: &[FrameTiming], quality: u8, label: &str) {
    if timings.is_empty() {
        return;
    }
    let n = timings.len() as f64;

    let avg_us =
        |f: fn(&FrameTiming) -> u64| -> f64 { timings.iter().map(f).sum::<u64>() as f64 / n };
    let max_us =
        |f: fn(&FrameTiming) -> u64| -> f64 { timings.iter().map(f).max().unwrap_or(0) as f64 };

    let avg_capture = avg_us(|t| t.capture_us);
    let avg_resize = avg_us(|t| t.resize_us);
    let avg_encode = avg_us(|t| t.encode_us);
    let avg_base64 = avg_us(|t| t.base64_us);
    let avg_total = avg_us(|t| t.total_us());
    let avg_jpeg_kb = avg_us(|t| t.jpeg_bytes as u64) / 1000.0;

    let max_total = max_us(|t| t.total_us());
    let min_total = timings.iter().map(|t| t.total_us()).min().unwrap_or(0) as f64;

    let src = timings.last().map(|t| (t.src_w, t.src_h)).unwrap_or((0, 0));

    println!(
        "\n── Summary  quality={quality} {label}  ({} frames) ─────────────────────────────",
        timings.len()
    );
    println!(
        "  Source resolution: {}×{}{}",
        src.0,
        src.1,
        if src.0 > MAX_W || src.1 > MAX_H {
            format!(" → resized to {}×{}", MAX_W.min(src.0), MAX_H.min(src.1))
        } else {
            String::new()
        }
    );
    println!("  Stage timings (average):");
    println!("    WGC capture      {:7.2} ms", avg_capture / 1000.0);
    println!("    resize           {:7.2} ms", avg_resize / 1000.0);
    println!("    JPEG encode      {:7.2} ms", avg_encode / 1000.0);
    println!("    base64           {:7.2} ms", avg_base64 / 1000.0);
    println!("    ─────────────────────────────");
    println!(
        "    TOTAL avg        {:7.2} ms  →  {:5.1} fps (pipeline-limited max)",
        avg_total / 1000.0,
        1_000_000.0 / avg_total
    );
    println!(
        "    TOTAL min        {:7.2} ms  →  {:5.1} fps",
        min_total / 1000.0,
        1_000_000.0 / min_total
    );
    println!(
        "    TOTAL max        {:7.2} ms  →  {:5.1} fps (worst case)",
        max_total / 1000.0,
        1_000_000.0 / max_total
    );
    println!("  JPEG size avg:     {:7.1} KB", avg_jpeg_kb);

    // Identify bottleneck
    let stages = [
        ("WGC capture", avg_capture),
        ("JPEG encode", avg_encode),
        ("base64", avg_base64),
    ];
    let bottleneck = stages
        .iter()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
        .unwrap();
    println!(
        "  ⚠ Bottleneck:     {} ({:.2} ms avg = {:.0}% of pipeline)",
        bottleneck.0,
        bottleneck.1 / 1000.0,
        bottleneck.1 / avg_total * 100.0
    );

    // Pipeline projection: capture and encode run on separate threads.
    let pipeline_bottleneck_us = avg_capture.max(avg_encode + avg_resize);
    println!("\n  Pipeline projection (capture ‖ encode on separate threads):");
    println!(
        "    bottleneck stage  {:7.2} ms  →  {:5.1} fps (expected in-app fps)",
        pipeline_bottleneck_us / 1000.0,
        1_000_000.0 / pipeline_bottleneck_us
    );
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    println!("╔══════════════════════════════════════════════════════════════════════╗");
    println!("║         Alpine – screen capture pipeline benchmark                   ║");
    println!("╚══════════════════════════════════════════════════════════════════════╝");
    println!("  Encoder:           jpeg-encoder (SIMD, RGB conversion + buffer reuse)");
    println!("  Frames per quality level: {FRAMES}");
    println!("  Max output resolution:    {MAX_W}×{MAX_H}");

    // Enumerate monitors
    let monitors = Monitor::all().expect("Failed to enumerate monitors");
    if monitors.is_empty() {
        eprintln!("No monitors found -cannot benchmark screen capture.");
        std::process::exit(1);
    }

    println!("\n  Available monitors:");
    for (i, m) in monitors.iter().enumerate() {
        println!(
            "    [{i}] {} ({}×{})",
            m.name().unwrap_or_else(|_| "Unknown".into()),
            m.width().unwrap_or(0),
            m.height().unwrap_or(0)
        );
    }

    // Always bench the primary (first) monitor.
    let monitor = &monitors[0];
    println!(
        "\n  Benchmarking monitor [0]: {}",
        monitor.name().unwrap_or_else(|_| "Unknown".into())
    );

    let mut all_summaries: Vec<(u8, &str, Vec<FrameTiming>)> = Vec::new();
    for &(quality, label) in QUALITIES {
        let timings = run_benchmark(monitor, quality, label);
        print_summary(&timings, quality, label);
        all_summaries.push((quality, label, timings));
    }

    // Cross-quality comparison
    println!("\n\n╔══ Quality comparison (avg total / fps / size) ══════════════════════╗");
    for (quality, label, timings) in &all_summaries {
        if timings.is_empty() {
            continue;
        }
        let n = timings.len() as f64;
        let avg_total = timings.iter().map(|t| t.total_us()).sum::<u64>() as f64 / n;
        let avg_jpeg_kb = timings.iter().map(|t| t.jpeg_bytes).sum::<usize>() as f64 / n / 1000.0;
        println!(
            "  quality={quality:3}  {label}  │  {:6.1}ms → {:5.1} fps  │  {:5.1} KB/frame",
            avg_total / 1000.0,
            1_000_000.0 / avg_total,
            avg_jpeg_kb
        );
    }
    println!("╚═════════════════════════════════════════════════════════════════════╝");
    println!("\nDone.");
}
