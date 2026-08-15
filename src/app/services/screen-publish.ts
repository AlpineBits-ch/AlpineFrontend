import {environment} from '../../environments/environment';
import {bitrateFor, StreamPreset, VideoCeiling} from '../models/stream-preset';
import {solveGeometry} from '../models/capture-geometry';
import {detectHost, PlatformHost} from '../platform/host';
import {ScreenPickerChoice} from './screen-picker.service';
import {IceServerConfig, ScreenPublishOptions} from './rust-media.service';

/**
 * Whether the share is owned by the {@link ScreenPublisher} port rather than published as a track on
 * this client's own peer connection.
 *
 * <p>The name is kept because two off-limits services branch on it, but the question it answers has
 * widened: it is now "does the publisher own this share", and there are two publishers. On desktop that
 * is the Rust one, behind `environment.rustPublisher` - the documented one-line rollback to the canvas
 * pipeline, unchanged and still meaning exactly that.</p>
 *
 * <p><b>Always true in a browser</b>, and deliberately not gated on that flag. There is no Rust side to
 * roll back to, so tying the web publisher to the Rust rollback switch would repurpose a flag whose whole
 * value is that it means one thing. The web publisher captures with `getDisplayMedia` and publishes the
 * track directly, which supersedes the canvas pipeline outright rather than falling back to it.</p>
 *
 * @param host defaults to {@link detectHost}, and every caller leaves it out. It is a parameter only so
 *        the decision can be exercised without a spec having to define `__TAURI_INTERNALS__` on
 *        `globalThis` - which `platform-boundary.spec.ts` counts as reaching around the ports, and which
 *        would in any case have been testing `detectHost()` rather than this rule. A free function
 *        rather than a port because two of its three callers are services this track may not edit.
 */
export function useRustPublisher(host: PlatformHost = detectHost()): boolean {
    return host === 'web' || environment.rustPublisher;
}

/**
 * STUN servers for the publisher. TURN entries are deliberately dropped.
 *
 * Cloudflare's SFU runs ICE-lite on public IPs, so reaching it needs no relay: the client's
 * outbound packet creates the NAT mapping and the SFU answers on it. Symmetric NAT only defeats
 * peer-to-peer hole punching, not a publicly addressable server, and Cloudflare configure STUN
 * without TURN for exactly this reason. TURN would only earn its place on a network that blocks
 * UDP outright.
 *
 * Dropping them is not merely tidy. `webrtc-rs` validates the configuration up front and rejects a
 * `turn:` URL with no credentials, and the native publish waits for ICE gathering to finish before
 * offering - so relay entries that cannot authenticate would add their whole timeout to the start
 * of every share.
 */
export function iceServers(): IceServerConfig[] {
    return environment.iceServers
        .map(server => ({
            urls: (Array.isArray(server.urls) ? server.urls : [server.urls])
                .filter(url => url.startsWith('stun:')),
            username: server.username,
            credential: server.credential,
        }))
        .filter(server => server.urls.length > 0);
}

/**
 * Build the argument set for a publish from a picker choice.
 *
 * Geometry is solved here, once, from the source's own dimensions - the same solve the canvas path
 * does - so both pipelines agree on what a preset means. **This is the only place a preset becomes
 * pixels**, on either host: the web adapter applies the numbers below as capture constraints and never
 * re-derives them, which is what keeps "1080p at 30" identical in a browser and on the desktop.
 */
export function publishOptions(
    choice: ScreenPickerChoice,
    shareId: string,
    apiBase: string,
    token: string,
    deviceId: string,
    target: {guildId: string; channelId: string} | {callId: string},
    ceiling: VideoCeiling | null | undefined,
): ScreenPublishOptions {
    const preset: StreamPreset = choice.preset;
    const {width, height} = solveGeometry(
        choice.sourceWidth, choice.sourceHeight, preset.resolution, ceiling);

    return {
        sourceId: choice.sourceId,
        shareId,
        width,
        height,
        fps: preset.framerate,
        kbps: bitrateFor(preset),
        content: preset.content,
        iceServers: iceServers(),
        apiBase,
        token,
        deviceId,
        shareAudio: choice.shareAudio,
        // Carried alongside the derived numbers, not instead of them: the web sender's encoding
        // parameters come from `applyScreenEncoding`, which takes the preset. Ignored by the Rust
        // publisher, whose encoder is built from the width/height/fps/kbps/content above.
        preset,
        ...target,
    };
}
