import {isTauri} from '@tauri-apps/api/core';
import {environment} from '../../environments/environment';
import {bitrateFor, StreamPreset} from '../models/stream-preset';
import {solveGeometry} from '../models/capture-geometry';
import {ScreenPickerChoice} from './screen-picker.service';
import {ScreenPublishOptions} from './rust-media.service';

/**
 * Whether screen shares should be published from Rust rather than through the canvas pipeline.
 *
 * Requires the desktop app: the publisher is a Tauri command, and in the browser there is no Rust
 * side at all.
 */
export function useRustPublisher(): boolean {
    return environment.rustPublisher && isTauri();
}

/** ICE server URLs flattened for the Rust publisher, which takes a plain list. */
export function iceUrls(): string[] {
    return environment.iceServers.flatMap(server =>
        Array.isArray(server.urls) ? server.urls : [server.urls],
    );
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
        iceUrls: iceUrls(),
        apiBase,
        token,
        ...target,
    };
}
