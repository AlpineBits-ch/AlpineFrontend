pub mod audio;
pub mod camera;
#[cfg(target_os = "windows")]
pub mod loopback_win;
/// Desktop-only: depends on `openh264`, `reqwest` and `webrtc`, none of which are mobile deps.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod publisher;
pub mod screen;
