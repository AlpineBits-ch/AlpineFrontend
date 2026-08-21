import {ChangeDetectionStrategy, Component, input, output} from '@angular/core';
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

const TOGGLE_BASE =
    'call-focusable group flex size-12 cursor-pointer items-center justify-center rounded-xl' +
    ' border-0 transition-all duration-150 active:scale-95';

const SEGMENT_BASE =
    'call-focusable cursor-pointer rounded border-0 px-2 py-1 text-xs leading-none tabular-nums' +
    ' transition-all active:scale-90';

@Component({
    selector: 'app-call-controls-bar',
    imports: [TranslateModule],
    templateUrl: './call-controls-bar.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallControlsBarComponent {
    // State inputs
    readonly isMuted = input.required<boolean>();
    readonly isDeafened = input.required<boolean>();
    readonly isCameraOn = input.required<boolean>();
    readonly isScreenSharing = input.required<boolean>();
    readonly screenHasAudio = input<boolean>(false);
    readonly screenAudioMuted = input<boolean>(false);
    /** Quality of the running share, so the active resolution and framerate read as selected. */
    readonly preset = input<StreamPreset | null>(null);
    /** Already-translated: "Disconnect" in a guild channel, "End call" in a DM. */
    readonly disconnectLabel = input.required<string>();

    /** Why starting the camera would be refused, as a translation key. Null while the camera is on. */
    readonly cameraBlockedKey = input<string | null>(null);
    /** The same, for screen share. */
    readonly shareBlockedKey = input<string | null>(null);
    /** "2 of 2 sharing", drawn beside the share button. Null when nothing counts publishers here. */
    readonly publisherSlots = input<SlotCount | null>(null);
    /** What the granted rung permits, so the picker stops where the plan does. Null offers everything. */
    readonly videoCeiling = input<VideoCeiling | null>(null);

    // Action outputs
    muteToggle = output<void>();
    deafenToggle = output<void>();
    cameraToggle = output<void>();
    screenShareToggle = output<void>();
    screenAudioToggle = output<void>();
    /** Emitted with the whole preset: resolution and framerate are never changed independently. */
    presetChange = output<StreamPreset>();
    disconnect = output<void>();

    protected readonly resolutions = Object.entries(RESOLUTION_LABELS).map(([value, label]) => ({
        value: value as StreamResolution,
        label,
    }));
    /** Must stay a copy: holding the imported binding directly reads as undefined under the test bundler. */
    protected readonly framerates: readonly StreamFramerate[] = [...FRAMERATE_OPTIONS];
    /** Copied for the same reason as {@link framerates}, and paired with its label key. */
    protected readonly contents: readonly {value: StreamContent; key: string}[] = CONTENT_OPTIONS.map(
        value => ({value, key: `CALL.CONTENT_${value.toUpperCase()}`}),
    );

    /**
     * The look of one control-bar toggle. `danger` is for a restriction the user placed on themselves
     * (muted, deafened); `brand` is for something they are actively doing (camera, screen share).
     */
    protected toggleClass(active: boolean, tone: 'danger' | 'brand', blocked = false): string {
        if (blocked) return `${TOGGLE_BASE} cursor-not-allowed bg-white/[0.04] text-text-faint`;
        if (!active) {
            return `${TOGGLE_BASE} bg-white/[0.07] text-text-secondary hover:bg-white/[0.12] hover:text-text-primary`;
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
            : `${SEGMENT_BASE} bg-transparent text-text-secondary hover:bg-white/[0.07] hover:text-text-primary`;
    }

    protected isResolution(resolution: StreamResolution): boolean {
        return this.preset()?.resolution === resolution;
    }

    protected isFramerate(framerate: StreamFramerate): boolean {
        return this.preset()?.framerate === framerate;
    }

    /** Whether the granted rung reaches this option. `Source` is always offered; the server clamps it. */
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

    /** No ceiling check, unlike the two rows above: content mode costs the room nothing. */
    protected setContent(content: StreamContent): void {
        const current = this.preset();
        if (current) this.presetChange.emit({...current, content});
    }
}
