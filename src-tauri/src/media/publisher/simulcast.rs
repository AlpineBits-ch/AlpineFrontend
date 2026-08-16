//! The simulcast ladder: how one session's geometry and bitrate become N encodings.
//!
//! Kept apart from the pump and the peer connection because it is the only part of simulcast that
//! can be proved without a GPU, a network or a second machine. Everything downstream applies these
//! numbers; nothing downstream decides them.

use super::encoder::EncoderSpec;

/// The rid names, highest layer first.
///
/// **Fixed by the server, not chosen here.** `Echo.Voice/Rooms/VoiceSubscriptionPlan.cs` declares
/// `VoiceVideoLayers` as `High = "a"`, `Medium = "b"`, `Low = "c"`, and the subscribe carries one of
/// those names as `preferredRid`. A layer published under any other name is one the SFU can never be
/// asked for, so it costs uplink and serves nobody.
pub const LAYER_RIDS: [&str; 3] = ["a", "b", "c"];

/// The shortest layer worth an encoder, in lines.
///
/// Below this the layer costs a Media Foundation session and a per-frame scale to save a viewer
/// almost nothing - the SFU's own floor for choosing the cheapest layer is 180 lines
/// (`VoiceSubscriptionOptions.LowLayerMaxHeight`), so 90 is already half of the smallest tile the
/// server will ever ask for.
const MIN_LAYER_HEIGHT: u32 = 90;

/// The floor on a layer's bitrate. Integer division of a small session budget would otherwise hand
/// the quarter layer 0 kbps, which some encoders accept and then produce nothing for.
pub const MIN_LAYER_KBPS: u32 = 100;

/// Each layer's bitrate as a percentage of **the top layer's**, highest layer first.
///
/// <p>H.264's rate need scales far more slowly than the pixel count, so a half-height layer is worth
/// much more than a quarter of the top layer's bitrate and a quarter-height layer much more than a
/// sixteenth. 100/32/10 is roughly the 1 : 1/3 : 1/10 that simulcast ladders in the wild converge
/// on, and it is deliberately the same curve the browser publisher uses - `LAYER_BITRATE_RATIO` in
/// `webrtc-encoding.ts`. The two publishers disagreeing meant the same share was measurably softer
/// from the desktop than from a browser, for no reason anybody chose.</p>
///
/// <p><b>The preset's number is the top layer's rate, not a total to divide up.</b> It used to be
/// the total, split 68/24/8, which kept every sharer's upload exactly where it had been before
/// simulcast existed. That reasoning had the ladder upside down. Measured in bits per pixel per
/// second the split made `a` the *thinnest* rung - 0.066 against `b`'s 0.093 and `c`'s 0.124 - and
/// `a` is the rung every viewer who is actually looking at the share is served. The layer that
/// mattered most was being starved to subsidise the two that mattered least, which is why a 1080p
/// share looked soft even full screen.</p>
///
/// <p>The cost is about 42% more uplink for the sharer. That is the trade simulcast was always
/// making on the room's behalf - one publisher's upload against the top layer times every viewer -
/// and the pricing model already assumed it was spent when the operator ceiling was raised.</p>
const LAYER_BITRATE_PERCENT_OF_TOP: [u32; 3] = [100, 32, 10];

/// One encoding: what to call it on the wire, and what to build an encoder for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layer {
    pub rid: &'static str,
    pub spec: EncoderSpec,
}

/// Round down to an even edge, with a floor of 2. H.264 4:2:0 cannot represent an odd one, and
/// `MediaFoundationEncoder::new` rejects it rather than degrading.
fn even(value: u32) -> u32 {
    let floored = value & !1;
    if floored < 2 {
        2
    } else {
        floored
    }
}

/// The ladder for one session, highest layer first.
///
/// <p>Never empty: a caller asking for zero layers still gets one, because the alternative is a
/// share that publishes nothing. A ladder that comes out one layer long is the pre-simulcast case
/// exactly - full geometry, full budget, and (in `Publication::start`) a track with no rid at all,
/// so the SDP is byte-identical to what shipped before this feature.</p>
pub fn layers_for(base: EncoderSpec, max_layers: usize) -> Vec<Layer> {
    let wanted = max_layers.clamp(1, LAYER_RIDS.len());
    let mut layers: Vec<Layer> = Vec::with_capacity(wanted);

    for index in 0..wanted {
        let width = even(base.width >> index);
        let height = even(base.height >> index);
        // Stop at the first layer too small to be worth encoding rather than skipping it: the rids
        // are ordered, and a ladder of `a` and `c` with no `b` would have the SFU's middle choice
        // fall back to the top layer, which is the cost this whole feature exists to avoid.
        if index > 0 && (height < MIN_LAYER_HEIGHT || width < MIN_LAYER_HEIGHT) {
            break;
        }
        layers.push(Layer {
            rid: LAYER_RIDS[index],
            spec: EncoderSpec {
                width,
                height,
                ..base
            },
        });
    }

    // One layer is the rollback path. It reads the same either way now that the top layer takes the
    // preset's rate whole, but it stays explicit: this is the branch that has to be byte-identical
    // to the pre-simulcast share, and it should not depend on the arithmetic below happening to
    // start at 100.
    if layers.len() == 1 {
        layers[0].spec.kbps = base.kbps;
        return layers;
    }

    for (index, layer) in layers.iter_mut().enumerate() {
        let share = base.kbps.saturating_mul(LAYER_BITRATE_PERCENT_OF_TOP[index]) / 100;
        layer.spec.kbps = share.max(MIN_LAYER_KBPS);
    }
    layers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::publisher::encoder::EncoderContent;

    fn spec(width: u32, height: u32, kbps: u32) -> EncoderSpec {
        EncoderSpec {
            width,
            height,
            fps: 60,
            kbps,
            content: EncoderContent::Games,
        }
    }

    #[test]
    fn builds_a_full_half_quarter_ladder() {
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        let sizes: Vec<(u32, u32)> = layers
            .iter()
            .map(|l| (l.spec.width, l.spec.height))
            .collect();
        assert_eq!(sizes, vec![(3840, 2160), (1920, 1080), (960, 540)]);
    }

    #[test]
    fn names_the_layers_as_the_server_does() {
        // Not cosmetic: the server selects by these exact names, so a rename here is a layer
        // nothing can ever ask for. Echo.Voice VoiceVideoLayers: High="a", Medium="b", Low="c".
        let layers = layers_for(spec(1280, 720, 4000), 3);
        assert_eq!(
            layers.iter().map(|l| l.rid).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn the_top_layer_gets_the_preset_rate_whole() {
        // The rung every viewer looking at the share is served, and it must not be shaved to pay
        // for the two below it. This asserts the inversion that made a 1080p share look soft even
        // full screen: `a` used to take 68% of the preset while `c` - a quarter-height thumbnail -
        // was the densest rung on the ladder per pixel.
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        assert_eq!(layers[0].spec.kbps, 16000);
    }

    #[test]
    fn the_lower_layers_cost_a_bounded_extra_on_top() {
        // The ladder is additive now, so the guard is on the *overhead*, not on a total. Roughly
        // 1.4x the top layer is what the ratios are chosen to cost; anything approaching double
        // means a lower rung has been inflated into a second full-rate stream, which is the shape
        // of regression this bound exists to catch.
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        let total: u32 = layers.iter().map(|l| l.spec.kbps).sum();
        assert!(
            total <= 16000 * 3 / 2,
            "the ladder cost {total} against a 16000 top layer, more than the 1.5x ceiling"
        );
        assert!(total > 16000, "the ladder is meant to be additive, not a split");
    }

    #[test]
    fn gives_the_top_layer_most_of_the_budget() {
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        assert!(layers[0].spec.kbps > layers[1].spec.kbps);
        assert!(layers[1].spec.kbps > layers[2].spec.kbps);
        assert!(layers[0].spec.kbps > 16000 / 2);
    }

    #[test]
    fn a_single_layer_keeps_the_whole_budget_and_the_full_size() {
        // The rollback path. One layer must be exactly what shipped before simulcast existed:
        // full geometry, full bitrate, nothing split off for layers that do not exist.
        let layers = layers_for(spec(1920, 1080, 8000), 1);
        assert_eq!(layers.len(), 1);
        assert_eq!((layers[0].spec.width, layers[0].spec.height), (1920, 1080));
        assert_eq!(layers[0].spec.kbps, 8000);
    }

    #[test]
    fn rounds_every_derived_edge_down_to_even() {
        // The encoder rejects an odd edge outright, and a rejected retype is a dead layer.
        for (w, h) in [(1286u32, 862u32), (1281, 721), (3441, 1441)] {
            for layer in layers_for(spec(w, h, 8000), 3) {
                assert_eq!(layer.spec.width % 2, 0, "{w}x{h} width");
                assert_eq!(layer.spec.height % 2, 0, "{w}x{h} height");
                assert!(layer.spec.width >= 2 && layer.spec.height >= 2);
            }
        }
    }

    #[test]
    fn drops_layers_too_small_to_be_worth_an_encoder() {
        // 320x180 quarters to 80x45, below the floor, so the ladder stops at two.
        let layers = layers_for(spec(320, 180, 1500), 3);
        assert_eq!(layers.len(), 2);
        assert_eq!((layers[1].spec.width, layers[1].spec.height), (160, 90));
    }

    #[test]
    fn collapses_to_one_layer_when_even_the_half_is_too_small() {
        let layers = layers_for(spec(160, 90, 600), 3);
        assert_eq!(layers.len(), 1);
        // ...and having collapsed, it is the single-layer case: full budget, not a split.
        assert_eq!(layers[0].spec.kbps, 600);
    }

    #[test]
    fn carries_framerate_and_content_onto_every_layer() {
        // Both are session properties, not per-layer ones. A layer encoded at a different rate
        // would drift out of step with the others frame by frame.
        let base = spec(1920, 1080, 8000);
        for layer in layers_for(base, 3) {
            assert_eq!(layer.spec.fps, base.fps);
            assert_eq!(layer.spec.content, base.content);
        }
    }

    #[test]
    fn zero_layers_is_treated_as_one() {
        // Defensive: a caller that computed a count of zero must still get a publishable share.
        assert_eq!(layers_for(spec(1920, 1080, 8000), 0).len(), 1);
    }

    #[test]
    fn every_layer_gets_a_usable_bitrate() {
        // Integer division on a small budget must not produce a 0 kbps layer, which some encoders
        // accept and then emit nothing for.
        for layer in layers_for(spec(1920, 1080, 300), 3) {
            assert!(layer.spec.kbps >= MIN_LAYER_KBPS);
        }
    }
}
