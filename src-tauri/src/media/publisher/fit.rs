use std::borrow::Cow;

use image::{imageops::FilterType, Rgba, RgbaImage};

/// Scale a captured frame into a fixed output size, preserving aspect ratio and padding the
/// remainder with black.
///
/// The encoder is created once at a fixed resolution and cannot accept a different frame size
/// mid-session. Captured sources do change size - a shared window being resized or maximised - so
/// every frame is fitted into the session's geometry rather than the geometry following the frame.
/// This is the same contract the canvas path holds on the TypeScript side.
///
/// Borrowed when the frame already fits, which is the top simulcast layer on every frame.
pub fn fit_into(source: &RgbaImage, width: u32, height: u32) -> Cow<'_, RgbaImage> {
    if source.width() == width && source.height() == height {
        return Cow::Borrowed(source);
    }

    if let Some(factor) = whole_reduction(source, width, height) {
        return Cow::Owned(block_average(source, factor));
    }

    // Triangle (bilinear) is ~5-8x faster than CatmullRom and the difference is imperceptible at
    // video frame rates once the H.264 encoder has been over it.
    let rect = fit_rect(source.dimensions(), (width, height));
    let scaled = image::imageops::resize(source, rect.width, rect.height, FilterType::Triangle);

    if rect.width == width && rect.height == height {
        return Cow::Owned(scaled);
    }

    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 255]));
    image::imageops::replace(&mut canvas, &scaled, rect.x as i64, rect.y as i64);
    Cow::Owned(canvas)
}

/// Where the picture sits inside the output box, with the remainder left as letterbox.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FitRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Fit `source` into `target`, preserving aspect ratio and centring what is left over.
///
/// The single definition of framing for both pipelines: the CPU path resizes to this and pads
/// around it, and the GPU path hands it to `VideoProcessorBlt` as the destination rectangle. Two
/// definitions would let the same share letterbox differently depending on the machine.
///
/// Every edge is even. NV12 subsamples chroma 2x2, so a picture that starts or ends on an odd
/// pixel puts a chroma sample half on the image and half on the black bar, which fringes the seam.
pub fn fit_rect(source: (u32, u32), target: (u32, u32)) -> FitRect {
    let (target_width, target_height) = target;
    let (source_width, source_height) = source;
    if source_width == 0 || source_height == 0 {
        return FitRect {
            x: 0,
            y: 0,
            width: target_width,
            height: target_height,
        };
    }

    let scale = (target_width as f64 / source_width as f64)
        .min(target_height as f64 / source_height as f64);
    // At least one chroma sample, or there is no picture to encode at all.
    let width = even(((source_width as f64 * scale).round() as u32).min(target_width)).max(2);
    let height = even(((source_height as f64 * scale).round() as u32).min(target_height)).max(2);

    FitRect {
        x: even(target_width.saturating_sub(width) / 2),
        y: even(target_height.saturating_sub(height) / 2),
        width: width.min(target_width),
        height: height.min(target_height),
    }
}

/// Round down to an even number.
fn even(value: u32) -> u32 {
    value & !1
}

/// The whole-number factor `source` reduces by to reach exactly `width` x `height`, if there is
/// one. Both axes must divide by the same factor, so the aspect ratio is preserved and nothing
/// needs letterboxing.
fn whole_reduction(source: &RgbaImage, width: u32, height: u32) -> Option<u32> {
    if width == 0 || height == 0 {
        return None;
    }
    let factor = source.width() / width;
    if factor < 2
        || source.width() % width != 0
        || source.height() % height != 0
        || source.height() / height != factor
    {
        return None;
    }
    Some(factor)
}

/// Average each `factor` x `factor` block into one pixel.
///
/// The exact area average, which is what a whole-number reduction wants and what the general
/// filter above only approximates: measured against a Lanczos3 reference this is ~6 dB closer,
/// and it reads each source pixel once instead of running a separable filter.
///
/// Every simulcast rung below the top is a whole-number reduction (`layers_for` shifts the
/// geometry right), as is a 4K monitor fitted into a 1080p share.
fn block_average(source: &RgbaImage, factor: u32) -> RgbaImage {
    let factor = factor as usize;
    let (width, height) = (
        source.width() as usize / factor,
        source.height() as usize / factor,
    );
    let stride = source.width() as usize * 4;
    let raw = source.as_raw();
    let divisor = (factor * factor) as u32;
    let mut out = vec![0u8; width * height * 4];

    for y in 0..height {
        let block_top = y * factor * stride;
        for x in 0..width {
            let block_left = block_top + x * factor * 4;
            let mut sums = [0u32; 4];
            for row in 0..factor {
                let start = block_left + row * stride;
                for pixel in raw[start..start + factor * 4].chunks_exact(4) {
                    for (sum, value) in sums.iter_mut().zip(pixel) {
                        *sum += *value as u32;
                    }
                }
            }
            let at = (y * width + x) * 4;
            for (slot, sum) in out[at..at + 4].iter_mut().zip(sums) {
                *slot = (sum / divisor) as u8;
            }
        }
    }

    RgbaImage::from_raw(width as u32, height as u32, out).expect("four bytes per pixel")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba(colour))
    }

    /// A flat source of one size fitted into another. The result is owned because `fit_into`
    /// borrows its input, and a source built inline would not outlive the call.
    fn fit_solid(source: (u32, u32), colour: [u8; 4], width: u32, height: u32) -> RgbaImage {
        fit_into(&solid(source.0, source.1, colour), width, height).into_owned()
    }

    #[test]
    fn returns_the_frame_untouched_when_it_already_fits() {
        let source = solid(320, 240, [10, 20, 30, 255]);
        let out = fit_into(&source, 320, 240);
        assert_eq!(out.dimensions(), (320, 240));
        assert_eq!(out.get_pixel(0, 0), &Rgba([10, 20, 30, 255]));
    }

    #[test]
    fn always_returns_exactly_the_requested_size() {
        // Whatever the source shape, the encoder must receive its declared geometry.
        for (w, h) in [(1920u32, 1080u32), (640, 480), (3440, 1440), (1080, 1920)] {
            let out = fit_solid((w, h), [255, 255, 255, 255], 1280, 720);
            assert_eq!(out.dimensions(), (1280, 720), "source {w}x{h}");
        }
    }

    #[test]
    fn letterboxes_a_wider_source_with_black_bars() {
        // 32:9 into 16:9 leaves bars top and bottom.
        let out = fit_solid((3200, 900), [255, 255, 255, 255], 1280, 720);
        assert_eq!(out.get_pixel(640, 0), &Rgba([0, 0, 0, 255]), "top bar");
        assert_eq!(out.get_pixel(640, 719), &Rgba([0, 0, 0, 255]), "bottom bar");
        assert_eq!(out.get_pixel(640, 360), &Rgba([255, 255, 255, 255]), "centre");
    }

    #[test]
    fn pillarboxes_a_taller_source_with_black_bars() {
        let out = fit_solid((900, 1600), [255, 255, 255, 255], 1280, 720);
        assert_eq!(out.get_pixel(0, 360), &Rgba([0, 0, 0, 255]), "left bar");
        assert_eq!(out.get_pixel(1279, 360), &Rgba([0, 0, 0, 255]), "right bar");
        assert_eq!(out.get_pixel(640, 360), &Rgba([255, 255, 255, 255]), "centre");
    }

    #[test]
    fn a_source_that_changes_size_mid_session_still_yields_one_geometry() {
        // A window being resized while shared: every frame must still come out at the session's
        // fixed size, because a change there would force a renegotiation and tear the stream.
        let sizes = [(1600u32, 900u32), (1284, 863), (800, 600), (1920, 1080)];
        for (w, h) in sizes {
            let out = fit_solid((w, h), [1, 2, 3, 255], 1920, 1080);
            assert_eq!(out.dimensions(), (1920, 1080), "source {w}x{h}");
        }
    }

    #[test]
    fn padding_is_opaque() {
        // A transparent pad would show up as garbage once converted to YUV for encoding.
        let out = fit_solid((3200, 900), [255, 255, 255, 255], 1280, 720);
        assert_eq!(out.get_pixel(640, 0)[3], 255);
    }

    #[test]
    fn upscales_a_source_smaller_than_the_target() {
        let out = fit_solid((320, 180), [7, 8, 9, 255], 1280, 720);
        assert_eq!(out.dimensions(), (1280, 720));
        assert_eq!(out.get_pixel(640, 360), &Rgba([7, 8, 9, 255]));
    }

    // ── Whole-number reductions ───────────────────────────────────────────────

    #[test]
    fn a_frame_that_already_fits_is_not_copied() {
        // Every simulcast top layer takes this path once a frame. An 8 MB memcpy for nothing.
        let source = solid(1920, 1080, [10, 20, 30, 255]);
        assert!(
            matches!(fit_into(&source, 1920, 1080), std::borrow::Cow::Borrowed(_)),
            "an identity fit copied the frame"
        );
    }

    #[test]
    fn a_halving_averages_each_two_by_two_block() {
        let mut source = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        source.put_pixel(0, 0, Rgba([100, 100, 100, 255]));
        source.put_pixel(1, 1, Rgba([200, 200, 200, 255]));

        let out = fit_into(&source, 2, 2);

        assert_eq!(out.dimensions(), (2, 2));
        // (100 + 0 + 0 + 200) / 4
        assert_eq!(out.get_pixel(0, 0), &Rgba([75, 75, 75, 255]));
        assert_eq!(out.get_pixel(1, 1), &Rgba([0, 0, 0, 255]));
    }

    #[test]
    fn a_quartering_averages_the_whole_four_by_four_block() {
        let mut source = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        for x in 0..4 {
            source.put_pixel(x, 0, Rgba([160, 160, 160, 255]));
        }

        let out = fit_into(&source, 1, 1);

        assert_eq!(out.dimensions(), (1, 1));
        // Four pixels of 160 across sixteen.
        assert_eq!(out.get_pixel(0, 0), &Rgba([40, 40, 40, 255]));
    }

    #[test]
    fn a_reduction_that_is_not_whole_on_both_axes_still_letterboxes() {
        // 1920x1080 into 960x1080 halves one axis and not the other, so the block average does not
        // apply and the general path has to keep the aspect ratio.
        let out = fit_solid((1920, 1080), [255, 255, 255, 255], 960, 1080);
        assert_eq!(out.dimensions(), (960, 1080));
        assert_eq!(out.get_pixel(480, 0), &Rgba([0, 0, 0, 255]), "top bar");
        assert_eq!(out.get_pixel(480, 540), &Rgba([255, 255, 255, 255]), "centre");
    }

    // ── Framing, shared by both pipelines ─────────────────────────────────────

    #[test]
    fn a_matching_aspect_ratio_fills_the_box() {
        assert_eq!(
            fit_rect((3840, 2160), (1920, 1080)),
            FitRect { x: 0, y: 0, width: 1920, height: 1080 }
        );
        // 2560x1440 is the same 16:9, so a 2K source fills a 1080p share with no bars at all.
        assert_eq!(
            fit_rect((2560, 1440), (1920, 1080)),
            FitRect { x: 0, y: 0, width: 1920, height: 1080 }
        );
    }

    #[test]
    fn a_wider_source_gets_bars_above_and_below() {
        let rect = fit_rect((3440, 1440), (1920, 1080));
        assert_eq!(rect.width, 1920);
        assert_eq!(rect.x, 0);
        assert!(rect.height < 1080, "a 21:9 source should not fill a 16:9 box");
        assert_eq!(rect.y * 2 + rect.height, 1080, "the bars should be equal");
    }

    #[test]
    fn a_taller_source_gets_bars_left_and_right() {
        let rect = fit_rect((1080, 1920), (1920, 1080));
        assert_eq!(rect.height, 1080);
        assert_eq!(rect.y, 0);
        assert!(rect.width < 1920);
        assert_eq!(rect.x * 2 + rect.width, 1920, "the bars should be equal");
    }

    #[test]
    fn every_edge_of_the_rect_is_even() {
        // Chroma is sampled 2x2. An odd edge puts a chroma sample half on the picture and half on
        // the bar, and the seam fringes.
        for source in [(1284, 863), (1920, 1081), (999, 777), (3815, 2081), (2560, 1440)] {
            for target in [(1920u32, 1080u32), (1280, 720), (960, 540), (2560, 1440)] {
                let rect = fit_rect(source, target);
                assert_eq!(rect.x % 2, 0, "{source:?} into {target:?}: x {}", rect.x);
                assert_eq!(rect.y % 2, 0, "{source:?} into {target:?}: y {}", rect.y);
                assert_eq!(rect.width % 2, 0, "{source:?} into {target:?}");
                assert_eq!(rect.height % 2, 0, "{source:?} into {target:?}");
            }
        }
    }

    #[test]
    fn the_rect_never_leaves_the_box() {
        for source in [(1284, 863), (320, 180), (7680, 4320), (2560, 1440), (1, 1)] {
            let rect = fit_rect(source, (1920, 1080));
            assert!(rect.x + rect.width <= 1920, "{source:?} overflowed the width");
            assert!(rect.y + rect.height <= 1080, "{source:?} overflowed the height");
        }
    }

    #[test]
    fn a_source_with_no_pixels_does_not_divide_by_zero() {
        let rect = fit_rect((0, 0), (1920, 1080));
        assert_eq!(rect.width, 1920);
        assert_eq!(rect.height, 1080);
    }

    #[test]
    fn a_halving_preserves_a_flat_colour_exactly() {
        let out = fit_solid((1920, 1080), [17, 34, 51, 255], 960, 540);
        assert_eq!(out.dimensions(), (960, 540));
        assert_eq!(out.get_pixel(0, 0), &Rgba([17, 34, 51, 255]));
        assert_eq!(out.get_pixel(959, 539), &Rgba([17, 34, 51, 255]));
    }
}
