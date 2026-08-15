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

/// Share of the session's budget per layer, in percent, highest layer first.
///
/// <p>H.264's rate need scales far more slowly than the pixel count, so a half-height layer is worth
/// much more than a quarter of the top layer's bitrate and a quarter-height layer much more than a
/// sixteenth. 68/24/8 is that curve rounded to something a human can check adds up.</p>
///
/// <p><b>The session budget is the total, not the top layer's allowance.</b> The alternative - full
/// rate on `a` and extra for the rest - raises every sharer's upload by about a third, which is a
/// regression on the exact connection simulcast is meant to be considerate of. The cost is that a
/// fullscreen viewer sees the top layer at 68% of the old rate; the benefit is that the other
/// thirteen stop pulling it at all.</p>
const LAYER_BUDGET_PERCENT: [u32; 3] = [68, 24, 8];

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

    // The budget is only split once there is something to split it with. One layer is the rollback
    // path and must keep the whole allowance.
    if layers.len() == 1 {
        layers[0].spec.kbps = base.kbps;
        return layers;
    }

    for (index, layer) in layers.iter_mut().enumerate() {
        let share = base.kbps.saturating_mul(LAYER_BUDGET_PERCENT[index]) / 100;
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
    fn never_spends_more_than_the_session_budget() {
        // The preset's kbps is the sharer's uplink budget, not the top layer's allowance. Sending
        // the full rate on `a` plus extra for `b` and `c` would raise every sharer's upload by
        // about a third for a feature meant to cut cost.
        let layers = layers_for(spec(3840, 2160, 16000), 3);
        let total: u32 = layers.iter().map(|l| l.spec.kbps).sum();
        assert!(total <= 16000, "ladder spent {total} of a 16000 budget");
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
