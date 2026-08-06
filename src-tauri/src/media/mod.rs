pub mod audio;
pub mod camera;
#[cfg(target_os = "windows")]
pub mod loopback_win;
/// Desktop-only: depends on `openh264`, `reqwest` and `webrtc`, none of which are mobile deps.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod publisher;
pub mod screen;
/// GDI thumbnails for the screen picker - Windows only, and a fast path rather than a capture
/// backend. See the module docs.
#[cfg(target_os = "windows")]
pub mod screen_thumb;
/// Desktop-only, for the same reason as `publisher`: `opus`, `rubato` and `webrtc` are not
/// mobile dependencies.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod voice;
