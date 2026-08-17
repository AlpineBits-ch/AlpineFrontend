//! Cheap window thumbnails for the screen picker.
//!
//! The picker needs a small still of every window the user might scroll past. Asking Windows
//! Graphics Capture for that is the wrong shape of request: `capture_image()` builds an entire
//! capture session per call - D3D device, frame pool, `GraphicsCaptureItem`, session start, wait
//! for the first frame, tear it all down - and then hands back a full-resolution surface that has
//! been copied out of video memory. Per window. On a busy desktop that is tens of seconds, nearly
//! all of it setup rather than pixels.
//!
//! WGC earns that cost for a *stream*, where the session is built once and then delivers frames for
//! an hour. For one still it is all overhead, so this takes the old path instead: `PrintWindow`
//! asks the window to draw itself into a device context, and GDI scales it down on the way into a
//! thumbnail-sized bitmap. No COM, no D3D, no capture session, and the only buffer read back is the
//! small one.
//!
//! It is not a replacement for WGC, and the caller keeps that path as a fallback: a window drawing
//! through a route `PrintWindow` cannot reach comes back blank, which {@link is_blank} detects.

#![cfg(windows)]

use image::{Rgba, RgbaImage};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    HALFTONE, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
// PrintWindow is filed under Storage::Xps in the windows crate, not WindowsAndMessaging.
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindow, PW_RENDERFULLCONTENT};

/// A device context plus the bitmap selected into it, released in the right order on the way out.
///
/// GDI objects are a process-wide finite resource, and the picker runs this once per window on
/// every open - a leak here would show up as the whole app failing to draw, a long way from its
/// cause.
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    width: i32,
    height: i32,
}

impl Surface {
    /// Allocates a top-down 32-bit BGRA surface of the given size.
    unsafe fn new(reference: HDC, width: i32, height: i32) -> Option<Self> {
        if width <= 0 || height <= 0 {
            return None;
        }

        let dc = CreateCompatibleDC(reference);
        if dc.is_invalid() {
            return None;
        }

        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        // Negative: a top-down DIB, so row 0 is the top and the buffer can be read straight through
        // rather than backwards.
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
        if bitmap.is_invalid() || bits.is_null() {
            let _ = DeleteDC(dc);
            return None;
        }

        let previous = SelectObject(dc, bitmap);
        Some(Self { dc, bitmap, previous, bits: bits.cast(), width, height })
    }

    /// The surface as BGRA bytes, four per pixel, rows packed (32-bit DIBs are always aligned).
    unsafe fn pixels(&self) -> &[u8] {
        std::slice::from_raw_parts(self.bits, (self.width * self.height * 4) as usize)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(self.bitmap);
            let _ = DeleteDC(self.dc);
        }
    }
}

/// A still of one window, scaled so its longest edge is at most `max_edge`.
///
/// Returns `None` when the window is gone, has no size, or drew nothing - all of which the caller
/// should treat as "try the capture API instead", not as "this window has no preview".
pub fn window_thumbnail(hwnd_id: u32, max_edge: u32) -> Option<RgbaImage> {
    let hwnd = HWND(hwnd_id as isize as *mut core::ffi::c_void);

    unsafe {
        if !IsWindow(hwnd).as_bool() {
            return None;
        }

        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).ok()?;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        if width <= 0 || height <= 0 {
            return None;
        }

        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let result = capture_window(screen, hwnd, width, height, max_edge);
        ReleaseDC(None, screen);
        result
    }
}

/// The body of {@link window_thumbnail}, split out so the screen DC is released on every path.
unsafe fn capture_window(
    screen: HDC,
    hwnd: HWND,
    width: i32,
    height: i32,
    max_edge: u32,
) -> Option<RgbaImage> {
    let full = Surface::new(screen, width, height)?;

    // PW_RENDERFULLCONTENT reaches windows that draw through DirectComposition - which is most of
    // them now, including anything Chromium-based. Without it those come back as an empty frame.
    let drawn = PrintWindow(hwnd, full.dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool();
    if !drawn {
        return None;
    }

    let (target_w, target_h) = fit(width, height, max_edge);
    let thumb = Surface::new(screen, target_w, target_h)?;

    // GDI does the resampling, so the only buffer read back is the small one. HALFTONE is the
    // averaging mode - the fast ones drop rows outright, which turns text into noise.
    SetStretchBltMode(thumb.dc, HALFTONE);
    let stretched = StretchBlt(
        thumb.dc, 0, 0, target_w, target_h,
        full.dc, 0, 0, width, height,
        SRCCOPY,
    )
    .as_bool();
    if !stretched {
        return None;
    }

    let image = to_rgba(thumb.pixels(), target_w as u32, target_h as u32);
    if is_blank(&image) {
        return None;
    }
    Some(image)
}

/// A still of a region of the virtual screen, for monitor thumbnails.
///
/// Cheaper than the window path - the desktop is already composited, so this is one scaled blit out
/// of the screen DC with nothing to ask a window to redraw.
pub fn screen_region_thumbnail(x: i32, y: i32, width: i32, height: i32, max_edge: u32) -> Option<RgbaImage> {
    if width <= 0 || height <= 0 {
        return None;
    }

    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }

        let (target_w, target_h) = fit(width, height, max_edge);
        let result = (|| {
            let thumb = Surface::new(screen, target_w, target_h)?;
            SetStretchBltMode(thumb.dc, HALFTONE);
            let ok = StretchBlt(
                thumb.dc, 0, 0, target_w, target_h,
                screen, x, y, width, height,
                SRCCOPY,
            )
            .as_bool();
            if !ok {
                return None;
            }
            let image = to_rgba(thumb.pixels(), target_w as u32, target_h as u32);
            if is_blank(&image) { None } else { Some(image) }
        })();

        ReleaseDC(None, screen);
        result
    }
}

/// Scales a size so its longest edge is `max_edge`, never enlarging and never reaching zero.
pub fn fit(width: i32, height: i32, max_edge: u32) -> (i32, i32) {
    let longest = width.max(height);
    if longest <= max_edge as i32 {
        return (width.max(1), height.max(1));
    }
    let scale = max_edge as f64 / longest as f64;
    (
        ((width as f64 * scale).round() as i32).max(1),
        ((height as f64 * scale).round() as i32).max(1),
    )
}

/// Turns a GDI BGRA surface into an `RgbaImage`.
///
/// Alpha is forced opaque: `PrintWindow` leaves it at zero for most windows, and a thumbnail that
/// is entirely transparent is indistinguishable from a failure once it reaches a JPEG.
pub fn to_rgba(bgra: &[u8], width: u32, height: u32) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    for (index, pixel) in image.pixels_mut().enumerate() {
        let offset = index * 4;
        match bgra.get(offset..offset + 4) {
            Some(chunk) => *pixel = Rgba([chunk[2], chunk[1], chunk[0], 255]),
            None => break,
        }
    }
    image
}

/// Whether a thumbnail carries no information - every pixel identical.
///
/// A window that draws through a route `PrintWindow` cannot reach hands back a uniform frame rather
/// than an error, and a flat rectangle in the picker looks like a bug rather than a fallback. The
/// caller retries such a source through the capture API.
pub fn is_blank(image: &RgbaImage) -> bool {
    let mut pixels = image.pixels();
    let Some(first) = pixels.next() else { return true };
    pixels.all(|pixel| pixel == first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_scales_the_longest_edge_down() {
        assert_eq!(fit(3840, 2160, 224), (224, 126));
    }

    #[test]
    fn fit_keeps_a_portrait_window_portrait() {
        let (w, h) = fit(600, 1800, 224);
        assert_eq!(h, 224);
        assert!(w < h);
    }

    #[test]
    fn fit_leaves_a_small_window_alone() {
        assert_eq!(fit(200, 120, 224), (200, 120));
    }

    #[test]
    fn fit_never_returns_zero() {
        // An extreme ratio rounds one edge towards nothing, and a zero-sized DIB cannot be created.
        let (w, h) = fit(4000, 3, 224);
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn bgra_becomes_rgba_with_opaque_alpha() {
        // GDI order is B, G, R, A - and PrintWindow leaves that alpha at zero.
        let surface = [10u8, 20, 30, 0];
        let image = to_rgba(&surface, 1, 1);
        assert_eq!(image.get_pixel(0, 0), &Rgba([30, 20, 10, 255]));
    }

    #[test]
    fn a_short_surface_does_not_panic() {
        let image = to_rgba(&[1, 2, 3, 4], 4, 4);
        assert_eq!(image.dimensions(), (4, 4));
    }

    #[test]
    fn a_uniform_frame_is_blank() {
        assert!(is_blank(&RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 255]))));
        assert!(is_blank(&RgbaImage::from_pixel(8, 8, Rgba([255, 255, 255, 255]))));
    }

    #[test]
    fn a_frame_with_any_variation_is_not_blank() {
        let mut image = RgbaImage::from_pixel(8, 8, Rgba([0, 0, 0, 255]));
        image.put_pixel(3, 3, Rgba([1, 0, 0, 255]));
        assert!(!is_blank(&image));
    }

    #[test]
    fn an_empty_frame_is_blank() {
        assert!(is_blank(&RgbaImage::new(0, 0)));
    }
}
