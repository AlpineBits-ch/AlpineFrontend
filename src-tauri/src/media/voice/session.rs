//! Owns a running voice session: the input device, the capture thread, and the peer connection.
//!
//! The capture thread is a plain OS thread rather than a tokio task. It wakes on a 10 ms timer and
//! does bounded DSP work, which would otherwise occupy a runtime worker for the whole call. Encoded
//! packets cross to the async side over a bounded channel, exactly as the screen publisher does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::capture;
use super::chain::{CaptureChain, ChainConfig};
use super::rtc::VoicePublication;
use super::{FRAME, FRAME_MS};
use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::Signalling;

/// How many encoded packets may queue between the capture thread and the async writer.
///
/// Small on purpose: voice that falls behind should drop rather than accumulate, because a backlog
/// becomes permanent latency that never recovers on its own.
const PACKET_QUEUE: usize = 8;

/// Emitted to the frontend. One channel carries every kind, so the webview subscribes once.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvent {
    pub kind: String,
    pub speaking: bool,
    pub level: f32,
    pub message: Option<String>,
}

impl VoiceEvent {
    pub fn speaking(speaking: bool, level: f32) -> Self {
        Self {
            kind: "speaking".into(),
            speaking,
            level,
            message: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            kind: "error".into(),
            speaking: false,
            level: 0.0,
            message: Some(message.into()),
        }
    }
}

/// State shared between the Tauri command thread and the capture thread.
///
/// Atomics rather than a mutex: the capture thread reads these every 10 ms on a deadline, and it
/// must never wait on a UI thread that happens to be holding a lock.
#[derive(Default)]
pub struct Control {
    muted: AtomicBool,
    ptt_down: AtomicBool,
    stopped: AtomicBool,
    /// Config changes are rare and larger than a word, so this one is a mutex - but it is only
    /// locked when `dirty` says something changed, so the per-frame path never touches it.
    pending_config: Mutex<Option<ChainConfig>>,
    dirty: AtomicBool,
}

impl Control {
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn ptt_down(&self) -> bool {
        self.ptt_down.load(Ordering::Relaxed)
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.ptt_down.store(down, Ordering::Relaxed);
    }

    pub fn running(&self) -> bool {
        !self.stopped.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    pub fn set_config(&self, config: ChainConfig) {
        if let Ok(mut guard) = self.pending_config.lock() {
            *guard = Some(config);
            self.dirty.store(true, Ordering::Release);
        }
    }

    fn take_config(&self) -> Option<ChainConfig> {
        if !self.dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.pending_config.lock().ok().and_then(|mut g| g.take())
    }
}

pub struct VoiceHandle {
    control: Arc<Control>,
    pub cf_session_id: String,
    pub track_name: String,
}

impl VoiceHandle {
    pub fn set_muted(&self, muted: bool) {
        self.control.set_muted(muted);
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.control.set_ptt_down(down);
    }

    pub fn set_config(&self, config: ChainConfig) {
        self.control.set_config(config);
    }

    pub fn stop(&self) {
        self.control.stop();
    }
}

pub async fn start(
    device_id: Option<String>,
    ice_servers: Vec<IceServerConfig>,
    signalling: Signalling,
    config: ChainConfig,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceHandle, String> {
    let (stream, mut reader, input_hz) = capture::open(device_id.as_deref())?;
    let mut chain = CaptureChain::new(input_hz, config)?;

    let publication = VoicePublication::start(signalling, ice_servers).await?;
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();

    let control = Arc::new(Control::default());
    let (packet_tx, mut packet_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(PACKET_QUEUE);

    // Writer task: the peer connection is async, the capture thread is a blocking OS thread, so
    // packets cross over here rather than blocking capture on the network.
    tokio::spawn(async move {
        while let Some(packet) = packet_rx.recv().await {
            if let Err(e) = publication.write_packet(packet).await {
                eprintln!("[voice] write failed, ending publication: {e}");
                break;
            }
        }
        publication.stop().await;
    });

    let thread_control = Arc::clone(&control);
    std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || {
            // Keeps the device open for the life of the thread.
            let _stream = stream;
            let tick = Duration::from_millis(FRAME_MS as u64);
            let mut frame = vec![0.0f32; FRAME];
            let mut last_speaking = false;
            let mut next = Instant::now();

            while thread_control.running() {
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    // Overran the budget. Resync rather than trying to catch up, which would spin
                    // and make the backlog worse.
                    next = now;
                }

                if let Some(config) = thread_control.take_config() {
                    chain.set_config(config);
                }
                chain.set_muted(thread_control.muted());
                chain.set_ptt_down(thread_control.ptt_down());

                // Drain everything the device produced, which may be more or fewer than one frame.
                while reader.read_frame(&mut frame) {
                    let status = chain.push(&frame, &mut |packet: &[u8]| {
                        // try_send, not send: dropping under backpressure keeps latency bounded,
                        // and a closed channel means the writer task already ended.
                        let _ = packet_tx.try_send(packet.to_vec());
                    });

                    if status.speaking != last_speaking {
                        last_speaking = status.speaking;
                        let _ = on_event.send(VoiceEvent::speaking(status.speaking, status.level));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(VoiceHandle {
        control,
        cf_session_id,
        track_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_changes_are_visible_to_the_capture_thread() {
        let control = Control::default();
        assert!(!control.muted());
        assert!(!control.ptt_down());

        control.set_muted(true);
        control.set_ptt_down(true);
        assert!(control.muted());
        assert!(control.ptt_down());
    }

    #[test]
    fn a_stopped_session_stays_stopped() {
        let control = Control::default();
        assert!(control.running());
        control.stop();
        assert!(!control.running());
        // Idempotent: a second stop from a different path must not resurrect it.
        control.stop();
        assert!(!control.running());
    }

    #[test]
    fn control_is_shareable_across_threads() {
        let control = Arc::new(Control::default());
        let other = Arc::clone(&control);
        std::thread::spawn(move || other.set_muted(true)).join().unwrap();
        assert!(control.muted());
    }

    #[test]
    fn a_config_is_delivered_exactly_once() {
        use crate::media::voice::gate::{GateConfig, InputMode};
        use crate::media::voice::process::ProcessConfig;

        let control = Control::default();
        assert!(
            control.take_config().is_none(),
            "nothing was set, so there is nothing to apply"
        );

        control.set_config(ChainConfig {
            processing: ProcessConfig::default(),
            gate: GateConfig {
                mode: InputMode::PushToTalk,
                sensitivity: 0.25,
                release_ms: 200,
            },
            bitrate_bps: 32_000,
        });

        let taken = control.take_config().expect("a pending config must be applied");
        assert_eq!(taken.bitrate_bps, 32_000);
        assert_eq!(taken.gate.mode, InputMode::PushToTalk);

        // Taken once and not again: reapplying every frame would reset the processor continuously.
        assert!(control.take_config().is_none());
    }

    #[test]
    fn a_speaking_event_carries_the_level() {
        let event = VoiceEvent::speaking(true, 0.42);
        assert_eq!(event.kind, "speaking");
        assert!(event.speaking);
        assert!((event.level - 0.42).abs() < f32::EPSILON);
        assert!(event.message.is_none());
    }

    #[test]
    fn an_error_event_carries_a_message() {
        let event = VoiceEvent::error("device lost");
        assert_eq!(event.kind, "error");
        assert!(!event.speaking);
        assert_eq!(event.message.as_deref(), Some("device lost"));
    }

    #[test]
    fn events_serialise_with_the_keys_the_frontend_reads() {
        let json = serde_json::to_value(VoiceEvent::speaking(true, 0.5)).unwrap();
        assert_eq!(json["kind"], "speaking");
        assert_eq!(json["speaking"], true);
        assert_eq!(json["level"], 0.5);
    }
}
