import {isTauri} from '@tauri-apps/api/core';
import {environment} from '../../environments/environment';
import {bitrateFor, StreamPreset} from '../models/stream-preset';
import {solveGeometry} from '../models/capture-geometry';
import {ScreenPickerChoice} from './screen-picker.service';
import {IceServerConfig, ScreenPublishOptions} from './rust-media.service';

/**
 * Whether screen shares should be published from Rust rather than through the canvas pipeline.
 *
 * Requires the desktop app: the publisher is a Tauri command, and in the browser there is no Rust
 * side at all.
 */
export function useRustPublisher(): boolean {
    return environment.rustPublisher && isTauri();
}

/**
 * STUN servers for the Rust publisher. TURN entries are deliberately dropped.
 *
 * Cloudflare's SFU runs ICE-lite on public IPs, so reaching it needs no relay: the client's
 * outbound packet creates the NAT mapping and the SFU answers on it. Symmetric NAT only defeats
 * peer-to-peer hole punching, not a publicly addressable server, and Cloudflare configure STUN
 * without TURN for exactly this reason. TURN would only earn its place on a network that blocks
 * UDP outright.
 *
 * Dropping them is not merely tidy. `webrtc-rs` validates the configuration up front and rejects a
 * `turn:` URL with no credentials, and this publish waits for ICE gathering to finish before
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
 * Build the argument set for a Rust publish from a picker choice.
 *
 * Geometry is solved here, once, from the source's own dimensions - the same solve the canvas path
 * does - so both pipelines agree on what a preset means.
 */
export function publishOptions(
    choice: ScreenPickerChoice,
    shareId: string,
    apiBase: string,
    token: string,
    deviceId: string,
    target: {guildId: string; channelId: string} | {callId: string},
): ScreenPublishOptions {
    const preset: StreamPreset = choice.preset;
    const {width, height} = solveGeometry(choice.sourceWidth, choice.sourceHeight, preset.resolution);

    return {
        sourceId: choice.sourceId,
        shareId,
        width,
        height,
        fps: preset.framerate,
        kbps: bitrateFor(preset),
        iceServers: iceServers(),
        apiBase,
        token,
        deviceId,
        ...target,
    };
}
