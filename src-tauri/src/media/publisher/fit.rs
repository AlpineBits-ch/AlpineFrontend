use image::{imageops::FilterType, DynamicImage, Rgba, RgbaImage};

/// Scale a captured frame into a fixed output size, preserving aspect ratio and padding the
/// remainder with black.
///
/// The encoder is created once at a fixed resolution and cannot accept a different frame size
/// mid-session. Captured sources do change size - a shared window being resized or maximised - so
/// every frame is fitted into the session's geometry rather than the geometry following the frame.
/// This is the same contract the canvas path holds on the TypeScript side.
pub fn fit_into(source: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    if source.width() == width && source.height() == height {
        return source.clone();
    }

    // Triangle (bilinear) is ~5-8x faster than CatmullRom and the difference is imperceptible at
    // video frame rates once the H.264 encoder has been over it.
    let scaled = DynamicImage::ImageRgba8(source.clone())
        .resize(width, height, FilterType::Triangle)
        .to_rgba8();

    if scaled.width() == width && scaled.height() == height {
        return scaled;
    }

    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 255]));
    let x = (width - scaled.width()) / 2;
    let y = (height - scaled.height()) / 2;
    image::imageops::replace(&mut canvas, &scaled, x as i64, y as i64);
    canvas
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba(colour))
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
            let out = fit_into(&solid(w, h, [255, 255, 255, 255]), 1280, 720);
            assert_eq!(out.dimensions(), (1280, 720), "source {w}x{h}");
        }
    }

    #[test]
    fn letterboxes_a_wider_source_with_black_bars() {
        // 32:9 into 16:9 leaves bars top and bottom.
        let out = fit_into(&solid(3200, 900, [255, 255, 255, 255]), 1280, 720);
        assert_eq!(out.get_pixel(640, 0), &Rgba([0, 0, 0, 255]), "top bar");
        assert_eq!(out.get_pixel(640, 719), &Rgba([0, 0, 0, 255]), "bottom bar");
        assert_eq!(out.get_pixel(640, 360), &Rgba([255, 255, 255, 255]), "centre");
    }

    #[test]
    fn pillarboxes_a_taller_source_with_black_bars() {
        let out = fit_into(&solid(900, 1600, [255, 255, 255, 255]), 1280, 720);
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
            assert_eq!(fit_into(&solid(w, h, [1, 2, 3, 255]), 1920, 1080).dimensions(), (1920, 1080));
        }
    }

    #[test]
    fn padding_is_opaque() {
        // A transparent pad would show up as garbage once converted to YUV for encoding.
        let out = fit_into(&solid(3200, 900, [255, 255, 255, 255]), 1280, 720);
        assert_eq!(out.get_pixel(640, 0)[3], 255);
    }

    #[test]
    fn upscales_a_source_smaller_than_the_target() {
        let out = fit_into(&solid(320, 180, [7, 8, 9, 255]), 1280, 720);
        assert_eq!(out.dimensions(), (1280, 720));
        assert_eq!(out.get_pixel(640, 360), &Rgba([7, 8, 9, 255]));
    }
}
