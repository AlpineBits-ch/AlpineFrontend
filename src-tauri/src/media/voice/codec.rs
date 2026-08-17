//! Opus coding for the voice pipeline.
//!
//! Configured the way a voice call actually needs and the previous pipeline never was: VoIP mode,
//! in-band FEC so a single lost packet is reconstructed from its successor rather than becoming an
//! audible hole, and DTX so silence costs no packets. The webview path called
//! `applySimpleBitrate`, which set a bitrate cap and nothing else - no FEC, no DTX, no packet-loss
//! signalling.

use opus::{Application, Bitrate, Channels, Decoder, Encoder};

use super::SAMPLE_RATE;

/// The largest packet Opus will emit. Buffers are sized to this once, at construction.
pub const MAX_PACKET: usize = 1275;

/// Samples per encoded packet - 20 ms at 48 kHz, two pipeline frames.
///
/// 20 ms is the standard voice packetisation: 10 ms would double per-packet overhead for no quality
/// gain, and 40 ms would add latency Discord does not pay.
pub const PACKET_SAMPLES: usize = 960;

pub struct VoiceEncoder {
    inner: Encoder,
}

impl VoiceEncoder {
    pub fn new(bitrate_bps: i32) -> Result<Self, String> {
        Self::with_application(Application::Voip, bitrate_bps)
    }

    /// An encoder for shared media - a screen share's own sound rather than a microphone.
    ///
    /// <p>Three differences from the voice configuration, all of which matter for music and game
    /// audio. `Application::Audio` keeps the full band instead of optimising for speech, which is
    /// what makes VoIP mode sound hollow on anything that is not a voice. DTX is off, because it
    /// decides "this is silence" from a speech model and clips quiet passages. FEC is off too: it
    /// spends bits on redundancy that matters for a conversation and much less for a stream nobody
    /// is talking over, and those bits are better spent on the band.</p>
    pub fn for_shared_media(bitrate_bps: i32) -> Result<Self, String> {
        let mut encoder = Self::with_application(Application::Audio, bitrate_bps)?;
        encoder.inner.set_dtx(false).map_err(|e| e.to_string())?;
        encoder
            .inner
            .set_inband_fec(false)
            .map_err(|e| e.to_string())?;
        Ok(encoder)
    }

    fn with_application(application: Application, bitrate_bps: i32) -> Result<Self, String> {
        let mut inner =
            Encoder::new(SAMPLE_RATE, Channels::Mono, application).map_err(|e| e.to_string())?;
        inner
            .set_bitrate(Bitrate::Bits(bitrate_bps))
            .map_err(|e| e.to_string())?;
        // FEC only spends bits once the encoder believes packets are being lost; the transport
        // updates this from RTCP. Starting at a low non-zero value means the first packets already
        // carry redundancy instead of waiting for the first report.
        inner.set_inband_fec(true).map_err(|e| e.to_string())?;
        inner.set_packet_loss_perc(5).map_err(|e| e.to_string())?;
        inner.set_dtx(true).map_err(|e| e.to_string())?;
        Ok(Self { inner })
    }

    pub fn encode(&mut self, pcm: &[f32], out: &mut [u8]) -> Result<usize, String> {
        if pcm.len() != PACKET_SAMPLES {
            return Err(format!(
                "expected {PACKET_SAMPLES} samples, got {}",
                pcm.len()
            ));
        }
        self.inner.encode_float(pcm, out).map_err(|e| e.to_string())
    }

    pub fn set_bitrate(&mut self, bps: i32) -> Result<(), String> {
        self.inner
            .set_bitrate(Bitrate::Bits(bps))
            .map_err(|e| e.to_string())
    }

    pub fn bitrate(&mut self) -> Result<i32, String> {
        match self.inner.get_bitrate().map_err(|e| e.to_string())? {
            Bitrate::Bits(bps) => Ok(bps),
            _ => Err("encoder is not using an explicit bitrate".into()),
        }
    }

    /// Tell the encoder how much loss the network is showing. This is what decides how many bits it
    /// spends on FEC redundancy.
    pub fn set_packet_loss(&mut self, pct: i32) -> Result<(), String> {
        self.inner
            .set_packet_loss_perc(pct.clamp(0, 100))
            .map_err(|e| e.to_string())
    }
}

pub struct VoiceDecoder {
    inner: Decoder,
}

impl VoiceDecoder {
    pub fn new() -> Result<Self, String> {
        Decoder::new(SAMPLE_RATE, Channels::Mono)
            .map(|inner| Self { inner })
            .map_err(|e| e.to_string())
    }

    pub fn decode(&mut self, packet: &[u8], out: &mut [f32]) -> Result<usize, String> {
        self.inner
            .decode_float(packet, out, false)
            .map_err(|e| e.to_string())
    }

    /// Reconstruct the packet *before* `next_packet` from the redundancy carried inside it.
    pub fn decode_fec(&mut self, next_packet: &[u8], out: &mut [f32]) -> Result<usize, String> {
        self.inner
            .decode_float(next_packet, out, true)
            .map_err(|e| e.to_string())
    }

    /// Packet-loss concealment: handed no data, Opus extrapolates from its own decoder state.
    pub fn conceal(&mut self, out: &mut [f32]) -> Result<usize, String> {
        self.inner
            .decode_float(&[], out, false)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    /// A couple of harmonics in the vocal range. Opus in VoIP mode treats a pure tone very
    /// differently from anything voice-shaped, so a realistic probe gives a realistic round trip.
    fn speechlike(len: usize, phase: usize) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = (i + phase) as f32 / SAMPLE_RATE as f32;
                0.3 * (TAU * 220.0 * t).sin() + 0.15 * (TAU * 440.0 * t).sin()
            })
            .collect()
    }

    fn rms(samples: &[f32]) -> f32 {
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    #[test]
    fn encodes_a_packet_worth_of_audio() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let n = enc.encode(&speechlike(PACKET_SAMPLES, 0), &mut buf).unwrap();
        assert!(n > 0 && n <= MAX_PACKET, "packet length {n}");
    }

    #[test]
    fn round_trips_to_the_same_length() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let n = enc.encode(&speechlike(PACKET_SAMPLES, 0), &mut buf).unwrap();

        let mut out = vec![0.0f32; PACKET_SAMPLES];
        let decoded = dec.decode(&buf[..n], &mut out).unwrap();
        assert_eq!(decoded, PACKET_SAMPLES);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn round_trip_preserves_signal_energy() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let mut out = vec![0.0f32; PACKET_SAMPLES];

        // Prime both ends: the first packets carry Opus's own startup transient.
        let mut phase = 0;
        for _ in 0..10 {
            let pcm = speechlike(PACKET_SAMPLES, phase);
            let n = enc.encode(&pcm, &mut buf).unwrap();
            dec.decode(&buf[..n], &mut out).unwrap();
            phase += PACKET_SAMPLES;
        }

        let pcm = speechlike(PACKET_SAMPLES, phase);
        let n = enc.encode(&pcm, &mut buf).unwrap();
        dec.decode(&buf[..n], &mut out).unwrap();

        let ratio = rms(&out) / rms(&pcm);
        assert!(ratio > 0.5 && ratio < 2.0, "energy ratio {ratio}");
    }

    #[test]
    fn conceal_produces_a_full_frame_without_a_packet() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf = [0u8; MAX_PACKET];
        let mut out = vec![0.0f32; PACKET_SAMPLES];

        let n = enc.encode(&speechlike(PACKET_SAMPLES, 0), &mut buf).unwrap();
        dec.decode(&buf[..n], &mut out).unwrap();

        let mut concealed = vec![0.0f32; PACKET_SAMPLES];
        let produced = dec.conceal(&mut concealed).unwrap();
        assert_eq!(produced, PACKET_SAMPLES);
        assert!(concealed.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn fec_recovers_a_lost_packet_from_the_next_one() {
        // In-band FEC embeds a coarse copy of packet N inside packet N+1, but only once the encoder
        // believes loss is happening - so the loss percentage has to be raised first.
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        enc.set_packet_loss(20).unwrap();
        let mut dec = VoiceDecoder::new().unwrap();
        let mut buf_a = [0u8; MAX_PACKET];
        let mut buf_b = [0u8; MAX_PACKET];

        enc.encode(&speechlike(PACKET_SAMPLES, 0), &mut buf_a).unwrap();
        let b = enc
            .encode(&speechlike(PACKET_SAMPLES, PACKET_SAMPLES), &mut buf_b)
            .unwrap();

        // Packet A never arrives; recover it from B.
        let mut out = vec![0.0f32; PACKET_SAMPLES];
        let produced = dec.decode_fec(&buf_b[..b], &mut out).unwrap();
        assert_eq!(produced, PACKET_SAMPLES);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn bitrate_is_adjustable_mid_session() {
        // Asserted through the encoder's own reported bitrate rather than packet sizes: Opus is
        // VBR by default, so a synthetic signal's packet size is a poor proxy for the setting.
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        assert_eq!(enc.bitrate().unwrap(), 64_000);

        enc.set_bitrate(24_000).unwrap();
        assert_eq!(enc.bitrate().unwrap(), 24_000);

        enc.set_bitrate(128_000).unwrap();
        assert_eq!(enc.bitrate().unwrap(), 128_000);
    }

    #[test]
    fn rejects_a_wrongly_sized_frame() {
        let mut enc = VoiceEncoder::new(64_000).unwrap();
        let mut buf = [0u8; MAX_PACKET];
        assert!(enc.encode(&vec![0.0; 123], &mut buf).is_err());
    }
}
