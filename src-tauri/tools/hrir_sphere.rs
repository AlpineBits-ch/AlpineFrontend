//! Converts the SADIE II HRIR measurements into the HRIR sphere the `hrtf` crate reads.
//!
//! ```text
//! rustc -O --edition 2021 hrir_sphere.rs -o hrir_sphere
//! ./hrir_sphere <D1_HRIR_WAV/48K_24bit> sadie_d1_48k.bin
//! ```
//!
//! Not built by cargo - it runs once per dataset, and the sphere it produces is what ships.
//!
//! # Why this exists
//!
//! `hrtf` does not read SOFA. It wants a mesh: magic, sample rate, HRIR length, vertex count, a
//! triangle index list, then per-vertex position and left/right impulse responses. The only
//! prebuilt spheres in that format are IRCAM's, which are licensed for research only. SADIE II is
//! Apache 2.0 (<https://www.york.ac.uk/sadie-project/database.html>) and therefore shippable, but
//! it is distributed as WAVs and SOFA, so somebody has to build the mesh. This is that step.
//!
//! # The measurement grid
//!
//! SADIE's D1 (KU100 dummy head) is 9201 files: 22 full rings of 400 azimuths, one point at -90,
//! and 400 points at +90 that all describe the same direction. Collapsing that pole to a single
//! vertex gives 8802, which is exactly the point count SADIE documents - so the collapse is the
//! intended reading, not a liberty. Rings are complete circles, which is what makes a plain
//! ring-to-ring stitch valid and a convex hull unnecessary.
//!
//! # Coordinates
//!
//! SADIE azimuth runs counter-clockwise seen from above, so +90 degrees is the listener's *left*.
//! The mixer's frame is +x right, +y up, +z forward, hence the negated sine. This is asserted, not
//! assumed: `mixer::tests::hrtf_sphere_places_sources_on_the_correct_side` loads the output and
//! fails if the ears come out swapped.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const HRIR_LEN: usize = 256;
const SAMPLE_RATE: u32 = 48_000;

/// Keep every Nth azimuth. 1 keeps SADIE's full 0.9 degree resolution and yields an 18 MB sphere;
/// 5 gives 4.5 degrees and under 4 MB, still finer than human lateral localisation blur. Raise it
/// if the download or the one-off BSP build at load time ever becomes the binding constraint.
const STRIDE: usize = 1;

struct Point {
    x: f32,
    y: f32,
    z: f32,
    left: Vec<f32>,
    right: Vec<f32>,
}

/// Decode a canonical PCM WAV into per-ear f32 vectors.
fn read_wav(path: &Path) -> Result<(Vec<f32>, Vec<f32>), String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(format!("{}: not a RIFF/WAVE file", path.display()));
    }

    // Walk the chunk list rather than assuming data starts at byte 44. These files are canonical,
    // but assuming it would turn any future variation into a silently wrong impulse response
    // instead of an error.
    let mut pos = 12usize;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data: Option<(usize, usize)> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        match id {
            b"fmt " => {
                channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
                bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
            }
            b"data" => data = Some((body, size.min(bytes.len() - body))),
            _ => {}
        }
        pos = body + size + (size & 1);
    }

    let (start, len) = data.ok_or_else(|| format!("{}: no data chunk", path.display()))?;
    if channels != 2 || bits != 24 {
        return Err(format!(
            "{}: expected 24-bit stereo, got {bits}-bit x{channels}",
            path.display()
        ));
    }

    let frames = len / 6;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for f in 0..frames {
        for (ear, out) in [(0usize, &mut left), (1usize, &mut right)] {
            let o = start + f * 6 + ear * 3;
            // 24-bit little-endian signed; the top byte is cast through i8 to sign-extend.
            let raw = (bytes[o] as i32)
                | ((bytes[o + 1] as i32) << 8)
                | ((bytes[o + 2] as i8 as i32) << 16);
            out.push(raw as f32 / 8_388_608.0);
        }
    }
    Ok((left, right))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: hrir_sphere <wav-dir> <out.bin>");
        std::process::exit(2);
    }
    let dir = Path::new(&args[1]);
    let out_path = Path::new(&args[2]);

    // elevation -> azimuth -> file, both in milli-degrees so the ordering is exact.
    let mut grid: BTreeMap<i32, BTreeMap<i32, PathBuf>> = BTreeMap::new();

    for entry in fs::read_dir(dir).expect("read_dir") {
        let path = entry.expect("entry").path();
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        // azi_-12,5_ele_30,0 - SADIE writes decimals with a comma.
        let Some(rest) = name.strip_prefix("azi_") else { continue };
        let Some((azi, ele)) = rest.split_once("_ele_") else { continue };
        let parse = |s: &str| -> Option<i32> {
            s.replace(',', ".").parse::<f64>().ok().map(|v| (v * 1000.0).round() as i32)
        };
        let (Some(azi), Some(ele)) = (parse(azi), parse(ele)) else { continue };
        grid.entry(ele).or_default().insert(azi, path);
    }

    let elevations: Vec<i32> = grid.keys().copied().collect();
    let mut points: Vec<Point> = Vec::new();
    let mut rings: Vec<(usize, usize)> = Vec::new(); // (first vertex index, count)

    for &ele in &elevations {
        let ring = &grid[&ele];
        let is_pole = ele.abs() == 90_000;
        let entries: Vec<(&i32, &PathBuf)> = if is_pole {
            ring.iter().take(1).collect()
        } else {
            ring.iter().step_by(STRIDE).collect()
        };

        let first = points.len();
        for (&azi, path) in &entries {
            let (left, right) = read_wav(path).expect("wav");
            assert_eq!(left.len(), HRIR_LEN, "{}", path.display());

            let a = (azi as f64 / 1000.0).to_radians();
            let e = (ele as f64 / 1000.0).to_radians();
            points.push(Point {
                // Negated sine: SADIE's azimuth grows to the left, the mixer's +x is to the right.
                x: (e.cos() * -a.sin()) as f32,
                y: e.sin() as f32,
                z: (e.cos() * a.cos()) as f32,
                left,
                right,
            });
        }
        rings.push((first, entries.len()));
    }

    // Stitch neighbouring rings into quads, fan the two poles.
    let mut indices: Vec<u32> = Vec::new();
    for pair in rings.windows(2) {
        let (lo_start, lo_count) = pair[0];
        let (hi_start, hi_count) = pair[1];
        match (lo_count, hi_count) {
            (1, n) => {
                for i in 0..n {
                    let (a, b) = (hi_start + i, hi_start + (i + 1) % n);
                    indices.extend([lo_start as u32, b as u32, a as u32]);
                }
            }
            (n, 1) => {
                for i in 0..n {
                    let (a, b) = (lo_start + i, lo_start + (i + 1) % n);
                    indices.extend([hi_start as u32, a as u32, b as u32]);
                }
            }
            (n, m) if n == m => {
                for i in 0..n {
                    let (l0, l1) = (lo_start + i, lo_start + (i + 1) % n);
                    let (h0, h1) = (hi_start + i, hi_start + (i + 1) % n);
                    indices.extend([l0 as u32, l1 as u32, h0 as u32]);
                    indices.extend([l1 as u32, h1 as u32, h0 as u32]);
                }
            }
            (n, m) => panic!("rings of {n} and {m} points cannot be stitched"),
        }
    }

    eprintln!(
        "{} vertices, {} triangles",
        points.len(),
        indices.len() / 3
    );

    let mut out = Vec::with_capacity(points.len() * (12 + HRIR_LEN * 8) + indices.len() * 4 + 20);
    out.extend(b"HRIR");
    out.extend(SAMPLE_RATE.to_le_bytes());
    out.extend((HRIR_LEN as u32).to_le_bytes());
    out.extend((points.len() as u32).to_le_bytes());
    out.extend((indices.len() as u32).to_le_bytes());
    for i in &indices {
        out.extend(i.to_le_bytes());
    }
    for p in &points {
        out.extend(p.x.to_le_bytes());
        out.extend(p.y.to_le_bytes());
        out.extend(p.z.to_le_bytes());
        for s in &p.left {
            out.extend(s.to_le_bytes());
        }
        for s in &p.right {
            out.extend(s.to_le_bytes());
        }
    }

    fs::File::create(out_path).expect("create").write_all(&out).expect("write");
    eprintln!("wrote {} ({:.1} MB)", out_path.display(), out.len() as f64 / 1e6);
}
