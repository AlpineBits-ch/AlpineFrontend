import {Component, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {SlotCount} from '../../../core/voice-limits';
import {
    CONTENT_OPTIONS,
    FRAMERATE_OPTIONS,
    isFramerateAllowed,
    isResolutionAllowed,
    RESOLUTION_LABELS,
    StreamContent,
    StreamFramerate,
    StreamPreset,
    StreamResolution,
    VideoCeiling,
} from '../../../models/stream-preset';

const TOGGLE_BASE = 'call-focusable group flex size-12 cursor-pointer items-center justify-center rounded-xl'
    + ' border-0 transition-all duration-150 active:scale-95';

const SEGMENT_BASE = 'call-focusable cursor-pointer rounded border-0 px-2 py-1 text-xs leading-none tabular-nums'
    + ' transition-all active:scale-90';

@Component({
    selector: 'app-call-controls-bar',
    imports: [TranslateModule],
    templateUrl: './call-controls-bar.component.html',
})
export class CallControlsBarComponent {
    // State inputs
    isMuted = input.required<boolean>();
    isDeafened = input.required<boolean>();
    isCameraOn = input.required<boolean>();
    isScreenSharing = input.required<boolean>();
    screenHasAudio = input<boolean>(false);
    screenAudioMuted = input<boolean>(false);
    /** Quality of the running share, so the active resolution and framerate read as selected. */
    preset = input<StreamPreset | null>(null);
    /** Already-translated: "Disconnect" in a guild channel, "End call" in a DM. */
    disconnectLabel = input.required<string>();

    /**
     * Why starting the camera would only be refused, as a translation key, or null when it would
     * not be.
     *
     * <p>The button is <b>disabled</b> rather than absent. An absent control reads as a client that
     * cannot do this at all, and this one can - on a room whose plan stretches further, or on this
     * one the moment a slot frees. Disabled with the reason on it is the honest shape, and the
     * reason is on the persistent notice above rather than buried in a tooltip alone.</p>
     *
     * <p>Null while the camera is on. Stopping is never blocked.</p>
     */
    cameraBlockedKey = input<string | null>(null);
    /** The same, for screen share. */
    shareBlockedKey = input<string | null>(null);
    /**
     * "2 of 2 sharing", drawn beside the share button.
     *
     * <p>Null when nothing counts publishers here, which is most instances. A denominator with no
     * numerator is half a sentence, so both halves arrive together or neither does.</p>
     */
    publisherSlots = input<SlotCount | null>(null);
    /**
     * What the granted rung permits, so the picker stops where the plan does.
     *
     * <p>Null offers everything, which is the right answer for "nothing has said": a client-side
     * clamp is a courtesy and the server is the enforcement.</p>
     */
    videoCeiling = input<VideoCeiling | null>(null);

    // Action outputs
    muteToggle = output<void>();
    deafenToggle = output<void>();
    cameraToggle = output<void>();
    screenShareToggle = output<void>();
    screenAudioToggle = output<void>();
    /** Emitted with the whole preset - resolution and framerate are never changed independently. */
    presetChange = output<StreamPreset>();
    disconnect = output<void>();

    protected readonly resolutions = Object.entries(RESOLUTION_LABELS)
        .map(([value, label]) => ({value: value as StreamResolution, label}));
    /**
     * A copy, not the shared array.
     *
     * <p>Two reasons, and the second is why this is not a style preference. Nothing reachable from a
     * template should be able to mutate a module constant several other files read. And holding the
     * imported binding directly initialised as `undefined` here under the bundler the test build
     * uses - the picker rendered zero framerate buttons, silently, with the resolution group beside
     * it drawn from a constant in the same module rendering fine.</p>
     */
    protected readonly framerates: readonly StreamFramerate[] = [...FRAMERATE_OPTIONS];
    /** Copied for the same reason as {@link framerates}, and paired with its label key. */
    protected readonly contents: readonly {value: StreamContent; key: string}[] =
        CONTENT_OPTIONS.map(value => ({value, key: `CALL.CONTENT_${value.toUpperCase()}`}));

    /**
     * The look of one control-bar toggle.
     *
     * <p>`danger` is for the toggles whose "on" state is a restriction the user has placed on
     * themselves (muted, deafened); `brand` is for the ones whose "on" state is a thing they are
     * actively doing (camera, screen share). The two were previously spelled out twice each as
     * eleven-class `ngClass` expressions inline.</p>
     */
    protected toggleClass(active: boolean, tone: 'danger' | 'brand', blocked = false): string {
        // Dimmed and not-allowed rather than hidden. The control still exists; the room is what
        // does not permit it right now.
        if (blocked) return `${TOGGLE_BASE} cursor-not-allowed bg-white/[0.04] text-white/20`;
        if (!active) {
            return `${TOGGLE_BASE} bg-white/[0.07] text-white/60 hover:bg-white/[0.12] hover:text-white/85`;
        }
        return tone === 'danger'
            ? `${TOGGLE_BASE} bg-offline/20 text-offline hover:bg-offline/30`
            : `${TOGGLE_BASE} bg-brand/20 text-brand-dim hover:bg-brand/30`;
    }

    /** One segment of the resolution or framerate picker. */
    protected segmentClass(active: boolean, allowed = true): string {
        if (!allowed) return `${SEGMENT_BASE} cursor-not-allowed bg-transparent text-white/15 line-through`;
        return active
            ? `${SEGMENT_BASE} bg-brand text-white`
            : `${SEGMENT_BASE} bg-transparent text-white/45 hover:bg-white/[0.07] hover:text-white/75`;
    }

    protected isResolution(resolution: StreamResolution): boolean {
        return this.preset()?.resolution === resolution;
    }

    protected isFramerate(framerate: StreamFramerate): boolean {
        return this.preset()?.framerate === framerate;
    }

    /**
     * Whether the granted rung reaches this option.
     *
     * <p>`Source` is always offered, whatever the ceiling: this client cannot know how tall the
     * captured screen is, and deciding what it maps to would be making the pricing decision the
     * server publishes a ladder to keep out of here. The server clamps it and says so.</p>
     */
    protected resolutionAllowed(resolution: StreamResolution): boolean {
        return isResolutionAllowed(resolution, this.videoCeiling());
    }

    /** A lower framerate is legal on every rung above `none`, so this only ever cuts the top off. */
    protected framerateAllowed(framerate: StreamFramerate): boolean {
        return isFramerateAllowed(framerate, this.videoCeiling());
    }

    protected setResolution(resolution: StreamResolution): void {
        const current = this.preset();
        if (current && this.resolutionAllowed(resolution)) {
            this.presetChange.emit({...current, resolution});
        }
    }

    protected setFramerate(framerate: StreamFramerate): void {
        const current = this.preset();
        if (current && this.framerateAllowed(framerate)) {
            this.presetChange.emit({...current, framerate});
        }
    }

    protected isContent(content: StreamContent): boolean {
        return this.preset()?.content === content;
    }

    /**
     * No ceiling check, unlike the two rows above.
     *
     * <p>The mode changes what the encoder gives up under congestion, never how much it spends - the
     * bitrate is the same in both - so it costs the room nothing and no rung has an opinion about
     * it. Adding a clamp here would be putting legibility behind a plan.</p>
     */
    protected setContent(content: StreamContent): void {
        const current = this.preset();
        if (current) this.presetChange.emit({...current, content});
    }
}
