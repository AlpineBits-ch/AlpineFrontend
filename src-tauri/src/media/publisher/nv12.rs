//! RGBA to NV12 conversion.
//!
//! Hardware video encoders take NV12, not RGBA, so every captured frame is converted before it
//! reaches the GPU. This runs on every frame of every stream - 124 megapixels per second at
//! 1080p60 - so it is integer fixed-point rather than floating point.
//!
//! Coefficients are BT.709 limited range. The matrix is signalled explicitly on the encoder's input
//! media type; leaving it unsignalled invites a decoder to guess BT.601 and render the stream with
//! visibly shifted colour.

use image::RgbaImage;

/// Size in bytes of an NV12 buffer for the given dimensions: a full-resolution luma plane followed
/// by a half-resolution interleaved chroma plane.
pub fn buffer_len(width: u32, height: u32) -> usize {
    let (w, h) = (width as usize, height as usize);
    w * h + w * h / 2
}

/// Convert an RGBA frame into `dst` as NV12, resizing `dst` to fit.
///
/// Dimensions must be even; NV12 subsamples chroma 2x2 and cannot represent an odd edge. The
/// geometry solver guarantees this upstream.
pub fn convert(src: &RgbaImage, dst: &mut Vec<u8>) {
    let width = src.width() as usize;
    let height = src.height() as usize;
    debug_assert!(width % 2 == 0 && height % 2 == 0, "NV12 requires even dimensions");

    dst.clear();
    dst.resize(buffer_len(src.width(), src.height()), 0);
    let (luma, chroma) = dst.split_at_mut(width * height);
    let raw = src.as_raw();

    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) * 4;
            let (r, g, b) = (raw[i] as i32, raw[i + 1] as i32, raw[i + 2] as i32);
            luma[y * width + x] = (((47 * r + 157 * g + 16 * b) >> 8) + 16) as u8;
        }
    }

    // Chroma is sampled once per 2x2 block. Averaging the block rather than point-sampling its
    // top-left pixel matters on screen content, where single-pixel text strokes otherwise drop out
    // of the chroma plane entirely and fringe.
    for y in (0..height).step_by(2) {
        for x in (0..width).step_by(2) {
            let mut r = 0i32;
            let mut g = 0i32;
            let mut b = 0i32;
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let i = ((y + dy) * width + (x + dx)) * 4;
                r += raw[i] as i32;
                g += raw[i + 1] as i32;
                b += raw[i + 2] as i32;
            }
            let (r, g, b) = (r / 4, g / 4, b / 4);

            let u = (((-26 * r - 87 * g + 112 * b) >> 8) + 128).clamp(0, 255) as u8;
            let v = (((112 * r - 102 * g - 10 * b) >> 8) + 128).clamp(0, 255) as u8;

            let offset = (y / 2) * width + x;
            chroma[offset] = u;
            chroma[offset + 1] = v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba(colour))
    }

    fn convert_solid(colour: [u8; 4]) -> (u8, u8, u8) {
        let mut buf = Vec::new();
        convert(&solid(4, 4, colour), &mut buf);
        (buf[0], buf[16], buf[17])
    }

    #[test]
    fn buffer_is_one_and_a_half_bytes_per_pixel() {
        assert_eq!(buffer_len(1920, 1080), 1920 * 1080 * 3 / 2);
        assert_eq!(buffer_len(4, 4), 24);
    }

    #[test]
    fn sizes_the_destination_buffer_itself() {
        let mut buf = vec![0xAA; 3];
        convert(&solid(64, 32, [0, 0, 0, 255]), &mut buf);
        assert_eq!(buf.len(), buffer_len(64, 32));
    }

    #[test]
    fn black_maps_to_the_limited_range_floor() {
        let (y, u, v) = convert_solid([0, 0, 0, 255]);
        assert_eq!(y, 16, "BT.709 limited range puts black at 16, not 0");
        assert!((127..=129).contains(&u), "u was {u}");
        assert!((127..=129).contains(&v), "v was {v}");
    }

    #[test]
    fn white_maps_to_the_limited_range_ceiling() {
        let (y, u, v) = convert_solid([255, 255, 255, 255]);
        assert!((234..=236).contains(&y), "expected ~235, got {y}");
        assert!((127..=129).contains(&u), "u was {u}");
        assert!((127..=129).contains(&v), "v was {v}");
    }

    #[test]
    fn grey_is_chroma_neutral() {
        let (_, u, v) = convert_solid([128, 128, 128, 255]);
        assert!((127..=129).contains(&u), "u was {u}");
        assert!((127..=129).contains(&v), "v was {v}");
    }

    #[test]
    fn primaries_push_chroma_in_the_expected_directions() {
        // Red is high V, low U; blue is the opposite. A sign error here shows as swapped colours.
        let (_, u_red, v_red) = convert_solid([255, 0, 0, 255]);
        assert!(v_red > 200, "red should have high V, got {v_red}");
        assert!(u_red < 110, "red should have low U, got {u_red}");

        let (_, u_blue, v_blue) = convert_solid([0, 0, 255, 255]);
        assert!(u_blue > 200, "blue should have high U, got {u_blue}");
        assert!(v_blue < 130, "blue should have low V, got {v_blue}");
    }

    #[test]
    fn luma_tracks_perceptual_brightness() {
        // BT.709 weights green far above red and red above blue.
        let (y_green, _, _) = convert_solid([0, 255, 0, 255]);
        let (y_red, _, _) = convert_solid([255, 0, 0, 255]);
        let (y_blue, _, _) = convert_solid([0, 0, 255, 255]);
        assert!(y_green > y_red, "green {y_green} should exceed red {y_red}");
        assert!(y_red > y_blue, "red {y_red} should exceed blue {y_blue}");
    }

    #[test]
    fn chroma_averages_the_two_by_two_block() {
        // A block that is half red and half black: the averaged chroma should land between the
        // two, where point-sampling the corner would snap to one extreme.
        let mut img = RgbaImage::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        img.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        img.put_pixel(1, 1, Rgba([255, 0, 0, 255]));

        let mut buf = Vec::new();
        convert(&img, &mut buf);
        let v = buf[5];
        let (_, _, v_full_red) = convert_solid([255, 0, 0, 255]);
        assert!(v > 130 && v < v_full_red, "expected an averaged V, got {v}");
    }

    #[test]
    fn every_pixel_of_the_luma_plane_is_written() {
        // A stale buffer reused across frames would otherwise leak the previous frame's edges.
        let mut buf = vec![0xFFu8; buffer_len(8, 8)];
        convert(&solid(8, 8, [0, 0, 0, 255]), &mut buf);
        assert!(buf[..64].iter().all(|&y| y == 16));
    }
}
