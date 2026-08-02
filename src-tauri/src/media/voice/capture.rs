//! cpal input: device selection, format negotiation, and the callback that feeds the ring.
//!
//! Everything here exists to get whatever the hardware offers into one shape - mono `f32` - so that
//! no stage downstream has to care what device is in use. Rate conversion is deliberately *not*
//! done here: the chain owns the resampler, because it is the chain that knows what rate it wants.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::ring::{self, RingReader};

/// How much audio the ring holds.
///
/// Generous on purpose: the capture thread wakes on a timer and the OS may not schedule it
/// promptly, especially on a loaded machine. 200 ms of slack costs 38 kB and prevents the dropouts
/// a tight ring would produce under ordinary scheduler jitter.
const RING_MS: u32 = 200;

/// A live input stream. Capture stops when this is dropped.
///
/// `cpal::Stream` holds raw pointers and is therefore not `Send`, but it is only ever moved between
/// threads while inert, never used from two at once - the same reasoning, and the same wrapper, as
/// the legacy `media::audio`.
pub struct InputStream(cpal::Stream);

// SAFETY: the stream is moved once, onto the capture thread, and then only dropped. cpal's own
// callback runs on a thread it owns and does not touch this handle.
unsafe impl Send for InputStream {}

impl InputStream {
    #[allow(dead_code)]
    pub fn pause(&self) {
        let _ = self.0.pause();
    }

    #[allow(dead_code)]
    pub fn play(&self) {
        let _ = self.0.play();
    }
}

/// Collapse interleaved multi-channel input to mono, replacing the contents of `out`.
///
/// Averaged rather than summed: summing two correlated channels doubles the amplitude, and a loud
/// stereo microphone would then clip before reaching any of the processing meant to prevent that.
pub fn downmix(input: &[f32], channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if channels == 0 {
        return;
    }
    if channels == 1 {
        // Still sanitise. A driver glitch that emits NaN would poison every filter downstream, and
        // unlike a merely loud sample it never washes out.
        out.extend(input.iter().map(|s| if s.is_finite() { *s } else { 0.0 }));
        return;
    }

    let scale = 1.0 / channels as f32;
    // `chunks_exact` discards a trailing partial frame. Emitting it would rotate the channel order
    // for every sample after it.
    for frame in input.chunks_exact(channels) {
        let sum: f32 = frame
            .iter()
            .map(|s| if s.is_finite() { *s } else { 0.0 })
            .sum();
        out.push(sum * scale);
    }
}

/// Open the requested input device and start streaming into a ring.
///
/// Returns the reader and the device's own sample rate.
pub fn open(device_id: Option<&str>) -> Result<(InputStream, RingReader, u32), String> {
    let host = cpal::default_host();

    // Devices are identified by name: cpal exposes no stable id, and the frontend already stores
    // names. A device that has disappeared falls back to the default rather than failing the call.
    let device = match device_id {
        Some(id) if id != "default" => host
            .input_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(id))
            .or_else(|| host.default_input_device()),
        _ => host.default_input_device(),
    }
    .ok_or_else(|| "no input device available".to_string())?;

    let supported = device
        .default_input_config()
        .map_err(|e| format!("no default input config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;

    // Which device was actually opened, not which one was asked for. The two differ whenever the
    // stored name no longer matches anything - the fallback above is silent, so a microphone that
    // was renamed or unplugged presents as a working capture of the wrong input.
    eprintln!(
        "[voice] capture device: {:?} (requested {:?}) - {sample_rate} Hz, {channels} ch",
        device.name().unwrap_or_else(|_| "<unnamed>".into()),
        device_id.unwrap_or("default"),
    );

    let config = cpal::StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        // Let the host choose. Demanding a specific size is how you get a device that refuses to
        // open at all, and the ring already decouples us from whatever it picks.
        buffer_size: cpal::BufferSize::Default,
    };

    let (mut writer, reader) = ring::channel(RING_MS);
    // Sized once, up front, so the callback never grows it. 100 ms is far beyond any real host
    // buffer; see the note below on what to do if that ever stops being true.
    let mut mono: Vec<f32> = Vec::with_capacity((sample_rate as usize / 10).max(1024));

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _| {
                // The entire real-time budget: downmix into a buffer that is already large enough,
                // then copy into the ring. No allocation, no lock, no syscall.
                downmix(data, channels, &mut mono);
                writer.write(&mono);
            },
            |err| eprintln!("[voice] input stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the input stream: {e}"))?;

    stream.play().map_err(|e| e.to_string())?;
    Ok((InputStream(stream), reader, sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_input_passes_through() {
        let mut out = Vec::new();
        downmix(&[0.1, 0.2, 0.3], 1, &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_is_averaged_not_summed() {
        let mut out = Vec::new();
        // Summing would clip a loud stereo source the moment both channels neared full scale.
        downmix(&[1.0, 1.0, -1.0, -1.0], 2, &mut out);
        assert_eq!(out, vec![1.0, -1.0]);
    }

    #[test]
    fn a_signal_in_one_channel_only_is_halved() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0], 2, &mut out);
        assert_eq!(out, vec![0.5]);
    }

    #[test]
    fn surround_input_is_averaged_across_every_channel() {
        let mut out = Vec::new();
        downmix(&[1.0, 1.0, 1.0, 1.0, 1.0, 1.0], 6, &mut out);
        assert_eq!(out, vec![1.0]);
    }

    #[test]
    fn a_trailing_partial_frame_is_discarded() {
        let mut out = Vec::new();
        // Five samples across two channels is two whole frames and a stray. Emitting the stray
        // would swap left and right for every subsequent sample.
        downmix(&[1.0, 1.0, 2.0, 2.0, 3.0], 2, &mut out);
        assert_eq!(out, vec![1.0, 2.0]);
    }

    #[test]
    fn non_finite_samples_are_replaced_with_silence() {
        let mut out = Vec::new();
        downmix(&[f32::NAN, 0.0, f32::INFINITY, 1.0], 2, &mut out);
        assert!(out.iter().all(|s| s.is_finite()), "got {out:?}");
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn non_finite_samples_are_replaced_in_mono_input_too() {
        let mut out = Vec::new();
        downmix(&[f32::NAN, 0.5, f32::NEG_INFINITY], 1, &mut out);
        assert_eq!(out, vec![0.0, 0.5, 0.0]);
    }

    #[test]
    fn the_output_buffer_is_reused_not_appended_to() {
        let mut out = vec![9.9; 32];
        downmix(&[0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5], "stale contents must not survive");
    }

    #[test]
    fn zero_channels_is_treated_as_no_audio() {
        let mut out = Vec::new();
        downmix(&[0.1, 0.2], 0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn an_empty_buffer_produces_no_output() {
        let mut out = vec![1.0; 4];
        downmix(&[], 2, &mut out);
        assert!(out.is_empty());
    }
}
